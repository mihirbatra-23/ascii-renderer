/**
 * Media contracts: decoding user input (images, animations, video) into frames the engine can sample.
 * Type detection is by magic bytes, never by MIME type or extension.
 */

export type MediaKind = 'image' | 'animation' | 'video';

interface MediaBase {
  kind: MediaKind;
  /** Original file name (or 'pasted image'). */
  name: string;
  /** Display size with EXIF / container rotation applied. */
  width: number;
  height: number;
  /** Bytes of the original file. */
  fileSize: number;
  /** Detected container/format label for the UI, e.g. 'PNG', 'JPEG', 'GIF', 'MP4 · H.264'. */
  formatLabel: string;
  hasAlpha: boolean;
  /**
   * Keep this media alive (e.g. for the duration of an export). dispose() is deferred until every retain has
   * been released; the returned function releases this retain (idempotent).
   */
  retain(): () => void;
  dispose(): void;
}

export interface LoadedImage extends MediaBase {
  kind: 'image';
  /**
   * The picture, at most 4096 px wide (wider than the widest analysis); `width` / `height` are the
   * file's own size, which the bitmap's may be smaller than (same aspect).
   */
  bitmap: ImageBitmap;
  /**
   * The same picture at most 512 px on its long side (the bitmap itself when it is already that small), for
   * cheap whole-image analysis (auto-levels, alpha probes, thumbnails) without touching the full-size bitmap.
   */
  thumbnail: ImageBitmap;
}

export interface LoadedAnimation extends MediaBase {
  kind: 'animation';
  frameCount: number;
  /** Per-frame display duration in ms (browser-style clamping applied: ≤10 ms → 100 ms). */
  durations: number[];
  totalMs: number;
  /** 0 = loop forever; otherwise the total number of plays (GIF NETSCAPE count n → n + 1, as browsers do). */
  loopCount: number;
  /**
   * Fully composited frame i (disposal + transparency handled). Cached (LRU) and cheap to call repeatedly; the
   * frame stays valid only until the cache evicts it, so use it right away (playback).
   */
  getFrame(index: number): Promise<ImageBitmap | HTMLCanvasElement | OffscreenCanvas>;
  /**
   * Frame i as a new ImageBitmap owned by the caller (close it when done). Bypasses the cache, so a sequential
   * pass such as an export neither evicts the preview's frames nor has its own frames closed under it.
   */
  readFrame(index: number): Promise<ImageBitmap>;
}

export interface LoadedVideo extends MediaBase {
  kind: 'video';
  /** A muted, inline, preloaded <video> for real-time playback (rotation applied by the browser). */
  element: HTMLVideoElement;
  /** The original file, for frame-accurate export with Mediabunny (empty for a live source). */
  file: Blob;
  /** Infinity for a live source. */
  durationSec: number;
  /** Best estimate of the average frame rate. */
  fps: number;
  hasAudio: boolean;
  codecLabel: string;
  /**
   * WebCodecs can decode the video track, so frame-accurate export through Mediabunny will work.
   * False when only the <video> element can play it (preview works, frame export does not).
   */
  canDecodeFrames?: boolean;
  /** A live camera stream (no duration, no seeking, no frame-accurate export; record in real time). */
  live?: boolean;
}

export type LoadedMedia = LoadedImage | LoadedAnimation | LoadedVideo;

export type MediaErrorCode =
  | 'unsupported-format'
  | 'heic-unsupported'
  | 'too-large'
  | 'decode-failed'
  | 'empty-file'
  | 'codec-unsupported'
  /** The camera is blocked: permission denied, an insecure (non-https) page or a site policy. Retrying won't help. */
  | 'camera-blocked'
  /** No camera, or it is busy / failed to start. Worth retrying once the camera is free. */
  | 'camera-unavailable';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /**
   * True when the same file may load on a second attempt (a timeout, a busy camera). Most failures are
   * properties of the file itself (damaged, too large, unsupported), so a retry would only repeat them.
   */
  readonly transient: boolean;
  constructor(code: MediaErrorCode, message: string, options: { transient?: boolean } = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.transient = options.transient ?? code === 'camera-unavailable';
  }
}

/** Limits enforced at load time (never silent: violations throw MediaError with a human message). */
export const MEDIA_LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  maxAnimationFrames: 2000,
  maxVideoSeconds: 600,
} as const;

/**
 * Playback for animations and videos. One interface for both so the UI's transport is uniform.
 * The player calls `onFrame` with each frame that should be shown; the app forwards it to the engine.
 */
export interface Player {
  /** Seconds; Infinity for a live source (play / pause only: seek and step do not move it). */
  readonly duration: number;
  readonly frameCount: number | null; // known for animations; null for video
  readonly playing: boolean;
  readonly currentTime: number; // seconds
  loop: boolean;
  /** Trim range in seconds; playback stays inside it. */
  inPoint: number;
  outPoint: number;
  play(): void;
  pause(): void;
  seek(timeSec: number): Promise<void>;
  /**
   * Step by ±n frames: animations by their frames; video by its real frame timestamps once they are indexed
   * (see frameTimes), by 1/fps until then. Live sources ignore it.
   */
  step(frames: number): Promise<void>;
  /**
   * Video only: the presentation time (s) of every frame, ascending, indexed in the background after the player
   * is created (variable-frame-rate clips step and count frames by these). null until known, for animations
   * (use LoadedAnimation.durations) and for live sources; onStateChange fires when it arrives.
   */
  readonly frameTimes?: Float64Array | null;
  onFrame(cb: (frame: import('../engine/types').FrameSource, timeSec: number) => void): () => void;
  onStateChange(cb: () => void): () => void;
  dispose(): void;
}
