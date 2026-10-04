/**
 * Real-time recording of a live source (a camera, LoadedVideo.live): every frame the camera presents
 * is rendered through the engine at the export size (async readback) and captured with
 * MediaRecorder, so the file shows exactly what the grid showed, with the current settings, at the
 * size the export panel promised. Frames the engine cannot keep up with are skipped rather than
 * queued, so the recording stays in real time.
 */
import type { AsciiEngine, SourceInfo } from '../engine/types';
import type { LoadedVideo } from '../media/types';
import { ExportError } from './errors';
import { exportFileName } from './filename';
import { evenSize } from './geometry';
import { planOutput, readPlanned, type OutputRequest } from './output';
import { transferableBytes } from './pixels';
import { CanvasRecorder, realtimeRecorderMime } from './realtime';
import type { ExportOptions, ExportResult } from './types';
import type { VideoContainer } from './video-codecs';

export interface RecordingOptions extends Pick<ExportOptions, 'format' | 'scale' | 'targetWidth' | 'margin' | 'transparentBackground'> {
  /** Source name, for the download name. */
  sourceName?: string;
  /** Video bitrate (default 8 Mbit/s: ASCII edges need it). */
  bitsPerSecond?: number;
}

export interface LiveRecording {
  /** What the browser records: the requested container, or the other one when only that is supported. */
  readonly container: VideoContainer;
  readonly mimeType: string;
  /** Recorded frame size (the export size padded to even numbers, like every video export). */
  readonly width: number;
  readonly height: number;
  /** Seconds recorded so far (frozen once stopped). */
  readonly elapsedSec: number;
  /** Frames captured so far. */
  readonly frames: number;
  readonly state: 'recording' | 'stopped';
  /** Stops recording and resolves with the file. */
  stop(): Promise<ExportResult>;
  /** Stops recording and discards it. */
  cancel(): Promise<void>;
}

/**
 * Starts recording `media` (a live camera) through `engine`. The recorder sets the engine's source to
 * the camera for every frame it captures; pass the preview engine to record exactly what is on screen
 * (later setting changes are recorded too), or a separate engine to lock the settings. The file's
 * size is fixed when recording starts (the export size, padded to even numbers): an exact width is
 * reached by the browser's high-quality scaling (resampling in JS could not keep up in real time),
 * and a grid whose size changes mid-recording is fitted inside it on the paper, never stretched.
 */
export function startRecording(engine: AsciiEngine, media: LoadedVideo, opts: RecordingOptions): LiveRecording {
  if (opts.format !== 'mp4' && opts.format !== 'webm') throw new ExportError('unsupported', `Recordings are MP4 or WebM, not ${opts.format}.`);
  const mimeType = realtimeRecorderMime(opts.format);
  if (!mimeType) throw new ExportError('unsupported', 'This browser can’t record video. Try a recent Chrome, Edge, Firefox or Safari.');
  const container: VideoContainer = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  // MediaRecorder support for alpha is too uneven to promise, so recordings keep the paper.
  const request: OutputRequest = { ...opts, transparentBackground: false };
  const info: SourceInfo = { width: media.width, height: media.height, animated: true };
  engine.setSource(media.element, info);
  const plan = planOutput(engine, request);
  const warnings: string[] = [];
  if (opts.transparentBackground) warnings.push('Recordings keep the paper colour (no transparency).');
  if (container !== opts.format) warnings.push(`This browser can only record ${container.toUpperCase()}; saved as .${container}.`);

  // captureStream() exists only on DOM canvases.
  const canvas = Object.assign(document.createElement('canvas'), evenSize(plan.size));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = engine.snapshot().params.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const staging = new OffscreenCanvas(1, 1);
  const stagingCtx = staging.getContext('2d');
  if (!stagingCtx) throw new Error('2D canvas context unavailable');
  const recorder = new CanvasRecorder(canvas, { mimeType, fps: 0, bitsPerSecond: opts.bitsPerSecond });
  const release = media.retain();
  const el = media.element;
  const startedAt = performance.now();
  let stoppedAt: number | null = null;
  let frames = 0;
  let inFlight: Promise<void> | null = null;
  let callback = 0;
  let failure: unknown = null;

  /** Draws a raster into the recording: as is when it is the planned size, else fitted on the paper. */
  const draw = (pixels: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }) => {
    const image = new ImageData(pixels.data, pixels.width, pixels.height);
    if (pixels.width === plan.size.width && pixels.height === plan.size.height) {
      ctx.putImageData(image, 0, 0);
      return;
    }
    if (staging.width !== pixels.width || staging.height !== pixels.height) {
      staging.width = pixels.width;
      staging.height = pixels.height;
    }
    stagingCtx.putImageData(image, 0, 0);
    const k = Math.min(plan.size.width / pixels.width, plan.size.height / pixels.height);
    const w = Math.round(pixels.width * k);
    const h = Math.round(pixels.height * k);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staging, Math.floor((plan.size.width - w) / 2), Math.floor((plan.size.height - h) / 2), w, h);
  };
  const capture = async () => {
    try {
      engine.setSource(el, info);
      // Re-planned per frame: with the preview engine, the grid can change while recording.
      const pixels = await readPlanned(engine, planOutput(engine, request));
      if (stoppedAt !== null) return;
      draw({ width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(transferableBytes(pixels)) });
      recorder.requestFrame();
      frames++;
    } catch (error) {
      failure ??= error;
    } finally {
      inFlight = null;
    }
  };
  const onFrame = () => {
    // A failed render ends capturing; stop() reports it.
    if (stoppedAt !== null || failure !== null) return;
    callback = schedule();
    // Still busy with the previous frame: skip this one (real time beats completeness).
    if (!inFlight) inFlight = capture();
  };
  const schedule = () => ('requestVideoFrameCallback' in el ? el.requestVideoFrameCallback(onFrame) : requestAnimationFrame(onFrame));
  const unschedule = () => ('requestVideoFrameCallback' in el ? el.cancelVideoFrameCallback(callback) : cancelAnimationFrame(callback));
  // Capture the frame on show now, then every frame the camera presents.
  onFrame();

  const finish = async (): Promise<Blob> => {
    if (stoppedAt === null) stoppedAt = performance.now();
    unschedule();
    try {
      await inFlight;
      return await recorder.stop();
    } finally {
      release();
    }
  };
  let ending: Promise<Blob> | null = null;

  return {
    container,
    mimeType,
    width: canvas.width,
    height: canvas.height,
    get elapsedSec() {
      return ((stoppedAt ?? performance.now()) - startedAt) / 1000;
    },
    get frames() {
      return frames;
    },
    get state() {
      return stoppedAt === null ? 'recording' : 'stopped';
    },
    async stop() {
      const blob = await (ending ??= finish());
      if (failure) throw failure instanceof Error ? failure : new ExportError('encode-failed', String(failure));
      if (frames === 0) throw new ExportError('empty', 'Nothing was recorded: the camera delivered no frames.');
      return {
        blob,
        fileName: exportFileName(opts.sourceName ?? media.name, plan.grid, container),
        width: canvas.width,
        height: canvas.height,
        warnings,
      };
    },
    async cancel() {
      await (ending ??= finish());
    },
  };
}
