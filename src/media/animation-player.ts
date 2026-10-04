/** Player for decoded frame sequences (GIF, animated WebP / APNG / AVIF). */
import type { FrameSource } from '../engine/types';
import { Emitter } from './emitter';
import { frameIndexAt, frameRange, frameStartTimes, wrapPlaybackTime } from './timeline';
import type { LoadedAnimation, Player } from './types';

/** Smallest trim range, in seconds. */
const MIN_SPAN_SEC = 0.001;

export class AnimationPlayer implements Player {
  readonly duration: number;
  readonly frameCount: number;
  /** Animations step by their own frames (LoadedAnimation.durations). */
  readonly frameTimes = null;

  private readonly starts: Float64Array;
  private readonly frames = new Emitter<[FrameSource, number]>();
  private readonly states = new Emitter<[]>();
  /** Media time while paused. While playing, time is derived from the anchor (drift-free). */
  private time = 0;
  private anchorTime = 0;
  private anchorWallMs = 0;
  private isPlaying = false;
  private rafHandle = 0;
  private trimIn = 0;
  private trimOut: number;
  private looping = true;
  /** Frame that should be on screen vs. the last one emitted; the pump closes the gap. */
  private wanted = -1;
  private shown = -1;
  private pump: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly media: LoadedAnimation) {
    this.starts = frameStartTimes(media.durations);
    this.duration = media.totalMs / 1000;
    this.frameCount = media.frameCount;
    this.trimOut = this.duration;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get currentTime(): number {
    return this.isPlaying ? this.clock().time : this.time;
  }

  get loop(): boolean {
    return this.looping;
  }

  set loop(value: boolean) {
    this.reanchor();
    this.looping = value;
    this.states.emit();
  }

  get inPoint(): number {
    return this.trimIn;
  }

  set inPoint(value: number) {
    this.reanchor();
    this.trimIn = clamp(value, 0, this.trimOut - MIN_SPAN_SEC);
    this.keepInsideTrim();
  }

  get outPoint(): number {
    return this.trimOut;
  }

  set outPoint(value: number) {
    this.reanchor();
    this.trimOut = clamp(value, this.trimIn + MIN_SPAN_SEC, this.duration);
    this.keepInsideTrim();
  }

  play(): void {
    if (this.isPlaying || this.disposed) return;
    if (this.time < this.trimIn || this.time >= this.trimOut) this.time = this.trimIn;
    this.isPlaying = true;
    this.anchorTime = this.time;
    this.anchorWallMs = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
    this.states.emit();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.time = this.clock().time;
    this.isPlaying = false;
    cancelAnimationFrame(this.rafHandle);
    // The clock can be past the frame the last tick asked for; show the one the paused time names,
    // so the picture, currentTime and a following step() agree.
    this.show(this.frameAt(this.time)).catch(reportError);
    this.states.emit();
  }

  async seek(timeSec: number): Promise<void> {
    this.time = clamp(timeSec, this.trimIn, this.trimOut);
    this.anchorTime = this.time;
    this.anchorWallMs = performance.now();
    this.states.emit();
    await this.show(this.frameAt(this.time), true);
  }

  async step(frames: number): Promise<void> {
    this.pause();
    const { first, last } = frameRange(this.starts, this.trimIn, this.trimOut);
    const from = this.wanted >= 0 ? this.wanted : this.frameAt(this.time);
    const target = clamp(from + Math.trunc(frames), first, last);
    this.time = Math.max(this.trimIn, this.starts[target] / 1000);
    this.states.emit();
    await this.show(target, true);
  }

  onFrame(cb: (frame: FrameSource, timeSec: number) => void): () => void {
    return this.frames.on(cb);
  }

  onStateChange(cb: () => void): () => void {
    return this.states.on(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.isPlaying = false;
    cancelAnimationFrame(this.rafHandle);
    this.frames.clear();
    this.states.clear();
  }

  private readonly tick = (): void => {
    if (!this.isPlaying || this.disposed) return;
    const { time, ended } = this.clock();
    if (ended) {
      this.time = this.trimOut;
      this.isPlaying = false;
      this.states.emit();
    } else {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
    this.show(this.frameAt(time)).catch((error: unknown) => {
      this.pause();
      reportError(error);
    });
  };

  /** Playback position from the wall clock since the last anchor, wrapped into the trim range. */
  private clock(): { time: number; ended: boolean } {
    const elapsed = (performance.now() - this.anchorWallMs) / 1000;
    return wrapPlaybackTime(this.anchorTime + elapsed, this.trimIn, this.trimOut, this.looping);
  }

  /** Re-bases the clock at the current position so a rule change does not jump playback. */
  private reanchor(): void {
    if (!this.isPlaying) return;
    this.anchorTime = this.clock().time;
    this.anchorWallMs = performance.now();
  }

  private keepInsideTrim(): void {
    const now = this.currentTime;
    if (now < this.trimIn || now > this.trimOut) void this.seek(now);
    else this.states.emit();
  }

  /** Frame shown at `timeSec`, limited to frames inside the trim range. */
  private frameAt(timeSec: number): number {
    const { first, last } = frameRange(this.starts, this.trimIn, this.trimOut);
    return clamp(frameIndexAt(this.starts, timeSec * 1000), first, last);
  }

  /**
   * Requests frame `index`. Frames decode asynchronously; rather than racing requests (and risking
   * never showing anything when decoding is slower than the frame rate), one pump emits each
   * finished frame and then catches up to the latest wanted index. Resolves once caught up.
   * `reemit` emits the frame even if it is already on screen (explicit seeks and steps always do).
   */
  private show(index: number, reemit = false): Promise<void> {
    if (reemit && index === this.shown) this.shown = -1;
    this.wanted = index;
    if (!this.pump && index !== this.shown) this.pump = this.runPump();
    return this.pump ?? Promise.resolve();
  }

  private async runPump(): Promise<void> {
    try {
      while (this.wanted !== this.shown && !this.disposed) {
        const index = this.wanted;
        let frame: FrameSource;
        try {
          frame = await this.media.getFrame(index);
        } catch (error) {
          // Closing the media (a new file, or the source's close button) disposes this player while a
          // frame is still decoding; that request then rejects as closed, which is expected, not a fault.
          if (this.disposed) return;
          throw error;
        }
        if (this.disposed) return;
        this.shown = index;
        this.frames.emit(frame, this.starts[index] / 1000);
      }
    } finally {
      this.pump = null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
