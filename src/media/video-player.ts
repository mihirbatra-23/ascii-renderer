/**
 * Player driving the LoadedVideo's <video> element; frames are emitted as the element presents them.
 * Files step by their real frame timestamps (indexed in the background, see frame-times.ts); a live
 * camera only plays and pauses.
 */
import type { FrameSource } from '../engine/types';
import { Emitter } from './emitter';
import { frameMidTime, readFrameTimes, stepFrameIndex } from './frame-times';
import type { LoadedVideo, Player } from './types';

/** After 'seeked', how long to wait for the element to present the new frame before emitting anyway. */
const SEEK_FRAME_GRACE_MS = 120;
/** Safety net for a 'seeked' event that never comes (should not happen; never hang a caller). */
const SEEK_TIMEOUT_MS = 10_000;
/** Tolerance when comparing media times (container timestamps are rarely exact in seconds). */
const EPSILON_SEC = 1e-3;

export class VideoPlayer implements Player {
  readonly duration: number;
  readonly frameCount = null;

  private readonly el: HTMLVideoElement;
  private readonly live: boolean;
  private readonly frameSec: number;
  private readonly frames = new Emitter<[FrameSource, number]>();
  private readonly states = new Emitter<[]>();
  private readonly emissions = new Emitter<[]>();
  /** Seeks waiting for 'seeked': dispose() settles them so no caller waits for the timeout. */
  private readonly pendingSeeks = new Set<() => void>();
  private times: Float64Array | null = null;
  private trimIn = 0;
  private trimOut: number;
  private looping = true;
  private frameCallback = 0;
  private rafHandle = 0;
  private disposed = false;
  private readonly removeListeners: () => void;

  constructor(media: LoadedVideo) {
    this.el = media.element;
    this.live = media.live === true;
    this.duration = this.live ? Infinity : media.durationSec;
    this.frameSec = 1 / media.fps;
    this.trimOut = this.duration;
    this.syncNativeLoop();

    const notify = () => this.states.emit();
    const onEnded = () => {
      if (this.looping && !this.live) {
        this.el.currentTime = this.trimIn;
        this.startPlayback();
      }
      notify();
    };
    const events = ['play', 'pause', 'seeked'] as const;
    for (const type of events) this.el.addEventListener(type, notify);
    this.el.addEventListener('ended', onEnded);
    this.removeListeners = () => {
      for (const type of events) this.el.removeEventListener(type, notify);
      this.el.removeEventListener('ended', onEnded);
    };
    this.watchFrames();
    if (!this.live) {
      void readFrameTimes(media.file).then((times) => {
        if (this.disposed || !times) return;
        this.times = times;
        this.states.emit();
      });
    }
  }

  get playing(): boolean {
    return !this.el.paused;
  }

  get currentTime(): number {
    return this.el.currentTime;
  }

  get frameTimes(): Float64Array | null {
    return this.times;
  }

  get loop(): boolean {
    return this.looping;
  }

  set loop(value: boolean) {
    this.looping = value;
    this.syncNativeLoop();
    this.states.emit();
  }

  get inPoint(): number {
    return this.trimIn;
  }

  set inPoint(value: number) {
    if (this.live) return;
    this.trimIn = clamp(value, 0, this.trimOut - this.frameSec);
    this.syncNativeLoop();
    this.keepInsideTrim();
  }

  get outPoint(): number {
    return this.trimOut;
  }

  set outPoint(value: number) {
    if (this.live) return;
    this.trimOut = clamp(value, this.trimIn + this.frameSec, this.duration);
    this.syncNativeLoop();
    this.keepInsideTrim();
  }

  play(): void {
    if (this.disposed || !this.el.paused) return;
    if (!this.live) {
      const t = this.el.currentTime;
      if (t < this.trimIn - EPSILON_SEC || t >= this.lastFrameTime()) this.el.currentTime = this.trimIn;
    }
    this.startPlayback();
  }

  pause(): void {
    this.el.pause();
  }

  seek(timeSec: number): Promise<void> {
    // A live stream has no timeline; "seek" just puts the current picture on screen.
    if (this.live) {
      this.emitCurrent();
      return Promise.resolve();
    }
    return this.seekElement(clamp(timeSec, this.trimIn, this.lastFrameTime()));
  }

  /**
   * Steps by whole frames: by the real frame timestamps once indexed, otherwise by the average frame
   * rate. Either way it lands mid-frame, so timestamp rounding cannot fall on a neighbour.
   */
  step(frames: number): Promise<void> {
    if (this.live) return Promise.resolve();
    this.pause();
    if (this.times) {
      const index = stepFrameIndex(this.times, this.el.currentTime, frames, this.trimIn, this.trimOut);
      return this.seekElement(clamp(frameMidTime(this.times, index, this.duration), this.trimIn, this.trimOut));
    }
    const index = Math.floor(this.el.currentTime / this.frameSec + EPSILON_SEC);
    return this.seek((index + Math.trunc(frames) + 0.5) * this.frameSec);
  }

  onFrame(cb: (frame: FrameSource, timeSec: number) => void): () => void {
    return this.frames.on(cb);
  }

  onStateChange(cb: () => void): () => void {
    return this.states.on(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.el.pause();
    this.el.loop = false;
    if (this.frameCallback) this.el.cancelVideoFrameCallback(this.frameCallback);
    cancelAnimationFrame(this.rafHandle);
    this.removeListeners();
    this.frames.clear();
    this.states.clear();
    this.emissions.clear();
    for (const settle of [...this.pendingSeeks]) settle();
  }

  /** Mid-point of the last frame that starts before the out point. */
  private lastFrameTime(): number {
    return Math.max(this.trimIn, this.trimOut - this.frameSec / 2);
  }

  private startPlayback(): void {
    // play() rejects with AbortError when a pause() interrupts it, which is expected here.
    this.el.play().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) reportError(error);
    });
  }

  /** Untrimmed loops use the element's own loop, which is gapless. */
  private syncNativeLoop(): void {
    this.el.loop = !this.live && this.looping && this.trimIn <= 0 && this.trimOut >= this.duration - EPSILON_SEC;
  }

  private keepInsideTrim(): void {
    const t = this.el.currentTime;
    if (t < this.trimIn - EPSILON_SEC || t > this.trimOut + EPSILON_SEC) void this.seek(t);
    else this.states.emit();
  }

  private watchFrames(): void {
    if ('requestVideoFrameCallback' in this.el) {
      const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
        if (this.disposed) return;
        this.frameCallback = this.el.requestVideoFrameCallback(onVideoFrame);
        this.presented(metadata.mediaTime);
      };
      this.frameCallback = this.el.requestVideoFrameCallback(onVideoFrame);
      return;
    }
    // Fallback: poll the playhead once per display frame.
    let lastTime = -1;
    const poll = () => {
      if (this.disposed) return;
      this.rafHandle = requestAnimationFrame(poll);
      const t = this.el.currentTime;
      if (t !== lastTime && this.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        lastTime = t;
        this.presented(t);
      }
    };
    this.rafHandle = requestAnimationFrame(poll);
  }

  /** Called for every frame the element presents; enforces the out point while playing. */
  private presented(mediaTime: number): void {
    if (!this.live && !this.el.paused && !this.el.loop && mediaTime >= this.trimOut - EPSILON_SEC) {
      // This frame lies past the trim range: don't show it; wrap or stop on the last frame inside.
      if (this.looping) this.el.currentTime = this.trimIn;
      else {
        this.el.pause();
        void this.seekElement(this.lastFrameTime());
      }
      return;
    }
    this.emitFrame(mediaTime);
  }

  private emitCurrent(): void {
    if (!this.disposed && this.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.emitFrame(this.el.currentTime);
  }

  private emitFrame(mediaTime: number): void {
    this.frames.emit(this.el, mediaTime);
    this.emissions.emit();
  }

  /** Seeks and resolves once the frame at the new position has been emitted. */
  private async seekElement(timeSec: number): Promise<void> {
    let emitted = false;
    const stopWatching = this.emissions.on(() => {
      emitted = true;
    });
    try {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.el.removeEventListener('seeked', done);
          this.pendingSeeks.delete(done);
          resolve();
        };
        const timer = setTimeout(done, SEEK_TIMEOUT_MS);
        this.el.addEventListener('seeked', done);
        this.pendingSeeks.add(done);
        this.el.currentTime = timeSec;
      });
      if (this.disposed) return;
      if (!emitted) await this.nextEmission(SEEK_FRAME_GRACE_MS);
      // Seeking within the frame already on screen presents nothing new; emit it explicitly.
      if (!emitted && !this.disposed) this.emitFrame(this.el.currentTime);
    } finally {
      stopWatching();
    }
  }

  private nextEmission(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const stop = this.emissions.on(finish);
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
