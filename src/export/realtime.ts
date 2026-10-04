import type { SourceInfo } from '../engine/types';
import type { LoadedVideo } from '../media/types';
import { abortError } from './errors';
import type { ExportFrame } from './frames';
import type { TimeRange } from './timing';
import type { VideoContainer } from './video-codecs';

/**
 * Real-time video capture with MediaRecorder: the last-resort export for browsers without WebCodecs
 * (frames painted into a canvas on the wall clock, so only as exact as the page's frame rate; the
 * UI labels these exports accordingly) and the camera recorder (recorder.ts).
 */

const MIME_PREFERENCE: Record<VideoContainer, string[]> = {
  mp4: ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'],
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'],
};

export function realtimeRecorderMime(format: VideoContainer): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return null;
  if (!('captureStream' in HTMLCanvasElement.prototype)) return null;
  return MIME_PREFERENCE[format].find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/** Saved-toast warning when the recorder can only write the other container. */
export function onlyRecords(container: VideoContainer): string {
  return `This browser can only record ${container === 'webm' ? 'WebM' : 'MP4'}. Saved as .${container}.`;
}

export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CanvasRecorderOptions {
  mimeType: string;
  /** Capture rate; 0 captures exactly the frames announced with requestFrame(). */
  fps: number;
  bitsPerSecond?: number;
}

/** MediaRecorder on a canvas's capture stream; started on construction. */
export class CanvasRecorder {
  private readonly stream: MediaStream;
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly stopped: Promise<void>;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly options: CanvasRecorderOptions,
  ) {
    this.stream = canvas.captureStream(options.fps);
    this.recorder = new MediaRecorder(this.stream, { mimeType: options.mimeType, videoBitsPerSecond: options.bitsPerSecond ?? 8_000_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    this.recorder.start(250);
  }

  /** With fps 0: the canvas now shows a new frame; capture it. */
  requestFrame(): void {
    for (const track of this.stream.getVideoTracks()) (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
  }

  /** Ends the recording and returns it. */
  async stop(): Promise<Blob> {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    for (const track of this.stream.getTracks()) track.stop();
    return new Blob(this.chunks, { type: this.options.mimeType.split(';')[0] });
  }
}

/**
 * Records `canvas` while `drive` paints into it. Resolves with the recording once `drive` finishes;
 * rejects with AbortError (and discards the recording) when `signal` fires.
 */
export async function recordCanvas(canvas: HTMLCanvasElement, options: CanvasRecorderOptions, drive: () => Promise<void>, signal: AbortSignal | undefined): Promise<Blob> {
  const recorder = new CanvasRecorder(canvas, options);
  let recording: Blob;
  try {
    await drive();
  } finally {
    recording = await recorder.stop();
  }
  if (signal?.aborted) throw abortError();
  return recording;
}

/** Resolves on the media element's next `type` event; rejects if it reports an error first. */
function mediaEvent(el: HTMLVideoElement, type: 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (event: Event) => {
      el.removeEventListener(type, settle);
      el.removeEventListener('error', settle);
      if (event.type === 'error') reject(new Error('The video couldn’t be played for recording. Try again.'));
      else resolve();
    };
    el.addEventListener(type, settle);
    el.addEventListener('error', settle);
  });
}

/** Media time of the next presented frame, or Infinity once playback has ended. */
function nextPresentedFrame(el: HTMLVideoElement, ended: Promise<number>): Promise<number> {
  const frame =
    typeof el.requestVideoFrameCallback === 'function'
      ? new Promise<number>((resolve) => el.requestVideoFrameCallback((_now, meta) => resolve(meta.mediaTime)))
      : new Promise<number>((resolve) => requestAnimationFrame(() => resolve(el.currentTime)));
  return Promise.race([frame, ended]);
}

/**
 * Plays the video's file through the trim range on an element of its own (muted), yielding as each
 * frame is presented. The media's own element, which the preview player drives, is never touched,
 * and the media is retained so closing it cannot cut the recording short.
 */
export async function* playbackFrames(video: LoadedVideo, range: TimeRange, signal?: AbortSignal): AsyncGenerator<ExportFrame> {
  const start = Math.max(0, range.startSec ?? 0);
  const end = Math.min(video.durationSec, range.endSec ?? video.durationSec);
  const info: SourceInfo = { width: video.width, height: video.height, animated: true };
  const release = video.retain();
  const url = URL.createObjectURL(video.file);
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.src = url;
  try {
    await mediaEvent(el, 'loadeddata');
    const seeked = mediaEvent(el, 'seeked');
    el.currentTime = start;
    await seeked;
    const ended = new Promise<number>((resolve) => el.addEventListener('ended', () => resolve(Infinity), { once: true }));
    await el.play();
    let last = start;
    while (!signal?.aborted) {
      const t = await nextPresentedFrame(el, ended);
      if (t >= end) break;
      yield { source: el, info, durationMs: Math.max(0, (t - last) * 1000) };
      last = t;
    }
  } finally {
    el.pause();
    el.removeAttribute('src');
    el.load();
    URL.revokeObjectURL(url);
    release();
  }
}
