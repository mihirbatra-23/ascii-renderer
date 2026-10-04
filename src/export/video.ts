import type { Conversion, DiscardedTrack } from 'mediabunny';
import type { AsciiEngine, FrameSource, SourceInfo } from '../engine/types';
import type { LoadedVideo } from '../media/types';
import { planAudio } from './audio';
import { context2d, createCanvas } from './canvas';
import { parseHex, unpack } from './color';
import { abortError, ExportError, throwIfAborted, withAbort } from './errors';
import { exportFileName } from './filename';
import type { ExportFrame } from './frames';
import { evenSize, type PixelSize } from './geometry';
import { needsResample, planOutput, readPlanned, type OutputPlan } from './output';
import { PaddedFrame, type Rgba } from './pixels';
import { FrameProgress, type ProgressCallback } from './progress';
import { RasterWorker } from './raster-worker';
import { delay, playbackFrames, realtimeRecorderMime, recordCanvas } from './realtime';
import type { TimeRange } from './timing';
import type { ExportOptions, ExportResult } from './types';
import { chooseVideoTarget, loadMediabunny, outputFormat, type Mediabunny, type VideoContainer, type VideoTarget } from './video-codecs';
import { yieldToEventLoop } from './yield';

/** Frames to encode when the source is an animation or a still (see frames.ts). */
export interface FrameSequence {
  kind: 'frames';
  frames: AsyncIterable<ExportFrame>;
  /** Number of frames, for progress and ETA. */
  frameCount?: number;
}

export type VideoExportInput = LoadedVideo | FrameSequence;

export interface VideoExportOptions
  extends Pick<
    ExportOptions,
    'format' | 'scale' | 'targetWidth' | 'margin' | 'transparentBackground' | 'startSec' | 'endSec' | 'fps' | 'includeAudio'
  > {
  /** Source file name, for the download name. */
  sourceName?: string;
  /**
   * The paper colour the engine renders with (pads the frame to an even size). Without it the paper
   * is read from the engine's snapshot, a synchronous readback of the whole grid.
   */
  paper?: string;
}

/** ASCII glyph edges are high-frequency detail; below 'high' they visibly ring. */
const QUALITY_LEVEL = 'high';
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function paperRgba(paper: string): Rgba {
  const [r, g, b] = unpack(parseHex(paper));
  return [r, g, b, 255];
}

/**
 * Renders frames through the engine at the export size (asynchronous readback, so the main thread
 * only copies pixels) and lays them into an even-sized frame, padded with the paper colour (or
 * transparency) and never scaled, as video encoders require. An exact target width is resampled in
 * a worker first. Frames are returned as raw RGBA or as VideoFrames built straight from it.
 */
class FrameRenderer {
  readonly size: PixelSize;
  private padded: PaddedFrame | null = null;
  private readonly resizer: RasterWorker | null;

  constructor(
    private readonly engine: AsciiEngine,
    private readonly plan: OutputPlan,
    private readonly alpha: boolean,
    private readonly paper: string | undefined,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.size = evenSize(plan.size);
    this.resizer = needsResample(plan) ? new RasterWorker() : null;
  }

  /** RGBA of `source` at the frame size. The buffer is reused by the next call. */
  async render(source: FrameSource, info: SourceInfo): Promise<Uint8ClampedArray<ArrayBuffer>> {
    this.engine.setSource(source, info);
    // The background is the paper the engine renders with, known once it has params and a source.
    this.padded ??= new PaddedFrame(this.size, this.alpha ? TRANSPARENT : paperRgba(this.paper ?? this.engine.snapshot().params.paper));
    let pixels = await readPlanned(this.engine, this.plan, this.signal);
    if (this.resizer) pixels = await this.resizer.resize(pixels, this.plan.size, this.signal);
    return this.padded.place(pixels);
  }

  /** `source` rendered as a VideoFrame stamped with the output time (seconds). */
  async videoFrame(source: FrameSource, info: SourceInfo, timestamp: number, duration: number): Promise<VideoFrame> {
    const data = await this.render(source, info);
    // VideoFrame copies the bytes, so the padded buffer can be reused for the next frame.
    return new VideoFrame(data, {
      format: this.alpha ? 'RGBA' : 'RGBX',
      codedWidth: this.size.width,
      codedHeight: this.size.height,
      timestamp: Math.round(timestamp * 1e6),
      duration: Math.round(duration * 1e6),
    });
  }

  dispose(): void {
    this.resizer?.terminate();
  }
}

/** What every encoding path shares for one export. */
interface Job {
  renderer: FrameRenderer;
  progress: FrameProgress;
  signal: AbortSignal | undefined;
  /** Notes for the user, appended as they come up. */
  warnings: string[];
}

/** WebCodecs paths also carry the lazily loaded Mediabunny module. */
interface EncodeJob extends Job {
  mb: Mediabunny;
}

function trimOf(opts: TimeRange): { start?: number; end?: number } | undefined {
  const trim: { start?: number; end?: number } = {};
  if (opts.startSec !== undefined) trim.start = opts.startSec;
  if (opts.endSec !== undefined) trim.end = opts.endSec;
  return trim.start === undefined && trim.end === undefined ? undefined : trim;
}

function audioWarning(discarded: DiscardedTrack[]): string | null {
  const audio = discarded.find((d) => d.track.isAudioTrack() && d.reason !== 'discarded_by_user');
  if (!audio) return null;
  const why =
    audio.reason === 'undecodable_source_codec' || audio.reason === 'unknown_source_codec'
      ? 'its codec can’t be decoded in this browser'
      : audio.reason === 'no_encodable_target_codec'
        ? 'this browser can’t encode audio for this format'
        : 'the output format can’t hold it';
  return `Audio not included: ${why}.`;
}

/** Video → video with Mediabunny: decode, render each frame, encode; source timestamps (VFR) and audio kept. */
async function convertVideo(job: EncodeJob, video: LoadedVideo, target: VideoTarget, alpha: boolean, opts: VideoExportOptions): Promise<ArrayBuffer> {
  const { mb, renderer, progress, signal } = job;
  const input = new mb.Input({ source: new mb.BlobSource(video.file), formats: mb.ALL_FORMATS });
  const bufferTarget = new mb.BufferTarget();
  const output = new mb.Output({ format: outputFormat(mb, target.container), target: bufferTarget });
  // Decoded samples are drawn here (rotation and pixel aspect applied) before the engine samples them.
  const scratch = createCanvas(1, 1);
  const scratchCtx = context2d(scratch);
  let frames = 0;
  let fraction = 0;
  let conversion: Conversion | null = null;
  const onAbort = () => void conversion?.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      trim: trimOf(opts),
      video: {
        codec: target.codec,
        forceTranscode: true,
        quality: new mb.Quality(QUALITY_LEVEL),
        alpha: alpha ? 'keep' : 'discard',
        frameRate: opts.fps,
        processedWidth: renderer.size.width,
        processedHeight: renderer.size.height,
        process: async (sample) => {
          throwIfAborted(signal);
          const w = sample.displayWidth;
          const h = sample.displayHeight;
          if (scratch.width !== w || scratch.height !== h) {
            scratch.width = w;
            scratch.height = h;
          }
          sample.draw(scratchCtx, 0, 0);
          const frame = await renderer.videoFrame(scratch, { width: w, height: h, animated: true }, sample.timestamp, sample.duration);
          progress.report(++frames, fraction);
          await yieldToEventLoop();
          return new mb.VideoSample(frame, { timestamp: sample.timestamp, duration: sample.duration });
        },
      },
      audio: opts.includeAudio
        ? async (track) => {
            const { plan, options } = await planAudio(track, target.container, mb.canEncodeAudio);
            if (plan.note) job.warnings.push(plan.note);
            return options;
          }
        : { discard: true },
    });
    if (!conversion.isValid) {
      const reason = conversion.discardedTracks.find((d) => d.track.isVideoTrack())?.reason ?? 'unknown';
      throw new ExportError('unsupported', `This video can’t be converted in this browser (${reason.replace(/_/g, ' ')}).`);
    }
    const audio = audioWarning(conversion.discardedTracks);
    if (audio && opts.includeAudio) job.warnings.push(audio);
    conversion.onProgress = (p) => {
      fraction = p;
    };
    throwIfAborted(signal);
    await conversion.execute();
    progress.finishing();
    if (!bufferTarget.buffer) throw new ExportError('encode-failed', 'The video encoder produced no data.');
    return bufferTarget.buffer;
  } catch (error) {
    if (error instanceof mb.ConversionCanceledError || signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
}

/** A frame sequence whose first frame has already been pulled (it sized the export). */
interface StartedSequence {
  iterator: AsyncIterator<ExportFrame>;
  first: IteratorResult<ExportFrame>;
}

/**
 * Animation / still → video: each frame added with an explicit timestamp and duration. The
 * sequence's iterator is returned by exportVideo, which started it.
 */
async function encodeFrames(job: EncodeJob, { iterator, first }: StartedSequence, target: VideoTarget, alpha: boolean): Promise<ArrayBuffer> {
  const { mb, renderer, progress, signal } = job;
  const bufferTarget = new mb.BufferTarget();
  const output = new mb.Output({ format: outputFormat(mb, target.container), target: bufferTarget });
  const source = new mb.VideoSampleSource({ codec: target.codec, quality: new mb.Quality(QUALITY_LEVEL), alpha: alpha ? 'keep' : 'discard' });
  output.addVideoTrack(source);
  let t = 0;
  let n = 0;
  try {
    await output.start();
    for (let next = first; !next.done; next = await withAbort(iterator.next(), signal)) {
      throwIfAborted(signal);
      const duration = next.value.durationMs / 1000;
      const sample = new mb.VideoSample(await renderer.videoFrame(next.value.source, next.value.info, t, duration));
      try {
        await withAbort(source.add(sample), signal);
      } finally {
        sample.close();
      }
      t += duration;
      progress.report(++n);
      await yieldToEventLoop();
    }
    progress.finishing();
    await withAbort(output.finalize(), signal);
    if (!bufferTarget.buffer) throw new ExportError('encode-failed', 'The video encoder produced no data.');
    return bufferTarget.buffer;
  } catch (error) {
    if (output.state !== 'finalized') await output.cancel().catch(() => undefined);
    throw error;
  }
}

/** No WebCodecs (or a video they can't decode): paint frames in real time and record the canvas with MediaRecorder. */
async function recordInRealtime(job: Job, input: LoadedVideo | StartedSequence, opts: VideoExportOptions, mimeType: string, fps: number): Promise<Blob> {
  const { renderer, progress, signal } = job;
  // A video is played on an element of its own (paced by playback); a sequence was started by
  // exportVideo, which also returns it, and is paced here by its frame durations.
  const frames =
    'kind' in input
      ? { iterator: playbackFrames(input, opts, signal)[Symbol.asyncIterator](), first: null, paced: true }
      : { iterator: input.iterator, first: input.first, paced: false };
  // captureStream() exists only on DOM canvases.
  const canvas = Object.assign(document.createElement('canvas'), renderer.size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const drive = async () => {
    try {
      const startedAt = performance.now();
      let dueMs = 0;
      let n = 0;
      for (let next = frames.first ?? (await frames.iterator.next()); !next.done; next = await frames.iterator.next()) {
        throwIfAborted(signal);
        const data = await renderer.render(next.value.source, next.value.info);
        ctx.putImageData(new ImageData(data, renderer.size.width, renderer.size.height), 0, 0);
        progress.report(++n);
        if (!frames.paced) {
          // A frame sequence is held for its duration on the wall clock.
          dueMs += next.value.durationMs;
          await delay(startedAt + dueMs - performance.now(), signal);
        }
      }
    } finally {
      if (frames.paced) await frames.iterator.return?.(undefined);
    }
  };
  return recordCanvas(canvas, { mimeType, fps }, drive, signal);
}

/**
 * MP4 (H.264) / WebM (VP9) export with Mediabunny and WebCodecs, frame-exact and off the preview's
 * clock. Frames are read back from the engine asynchronously and handed to the encoder as
 * VideoFrames built from the pixels, yielding to the event loop after each, so the editor stays
 * responsive and Cancel (AbortError) lands within a frame. Falls back to another codec/container
 * when the preferred one can't be encoded at this size (and says so in `warnings`), and to
 * real-time MediaRecorder capture without WebCodecs or when they can't decode the source video
 * (LoadedVideo.canDecodeFrames false). Dimensions are the output size padded to even numbers with
 * the paper colour (never scaled). A LoadedVideo input is retained until the export settles, so
 * closing it meanwhile cannot break the export; a frame sequence retains its own source
 * (frames.ts). Live cameras are recorded with startRecording (recorder.ts) instead.
 */
export async function exportVideo(
  engine: AsciiEngine,
  input: VideoExportInput,
  opts: VideoExportOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  throwIfAborted(signal);
  const format = opts.format;
  if (format !== 'mp4' && format !== 'webm') {
    throw new ExportError('unsupported', `exportVideo cannot write ${format}`);
  }
  if (input.kind === 'video' && input.live) {
    throw new ExportError('unsupported', 'A live camera has no frames to convert; record it instead.');
  }
  const release = input.kind === 'video' ? input.retain() : null;
  // The grid (and so the export size) follows the source's size, so the engine gets the source first.
  let sequence: StartedSequence | null = null;
  try {
    if (input.kind === 'video') {
      engine.setSource(input.element, { width: input.width, height: input.height, animated: true });
    } else {
      const iterator = input.frames[Symbol.asyncIterator]();
      sequence = { iterator, first: await withAbort(iterator.next(), signal) };
      if (sequence.first.done) throw new ExportError('empty', 'There are no frames to export.');
      engine.setSource(sequence.first.value.source, sequence.first.value.info);
    }
    return await encodeVideo(engine, input.kind === 'video' ? input : sequence!, input, { ...opts, format }, onProgress, signal);
  } finally {
    // Lets the frame source release its frame and decoders when the export stopped early.
    await sequence?.iterator.return?.();
    release?.();
  }
}

/** exportVideo once the engine shows the first frame: picks the codec, renders and encodes. */
async function encodeVideo(
  engine: AsciiEngine,
  source: LoadedVideo | StartedSequence,
  input: VideoExportInput,
  opts: VideoExportOptions & { format: VideoContainer },
  onProgress: ProgressCallback | undefined,
  signal: AbortSignal | undefined,
): Promise<ExportResult> {
  const format = opts.format;
  const warnings: string[] = [];
  let alpha = opts.transparentBackground && format === 'webm';
  if (opts.transparentBackground && format === 'mp4') {
    warnings.push('MP4 can’t store transparency; the paper colour fills the background.');
  }
  const planned = planOutput(engine, { ...opts, transparentBackground: false });
  const expected = evenSize(planned.size);
  // Some files play in the <video> element but cannot be decoded by WebCodecs (LoadedVideo.canDecodeFrames):
  // those can only be recorded from playback.
  const decodable = input.kind !== 'video' || input.canDecodeFrames !== false;
  let choice = decodable ? await chooseVideoTarget(format, expected.width, expected.height, alpha) : null;
  if (!choice && alpha) {
    if (decodable) {
      choice = await chooseVideoTarget(format, expected.width, expected.height, false);
      if (choice) warnings.push('This browser can’t encode transparent video; the paper colour fills the background.');
    }
    alpha = false;
  }
  if (choice?.warning) warnings.push(choice.warning);
  const plan: OutputPlan = { ...planned, raster: { ...planned.raster, transparentBackground: alpha } };

  const total =
    input.kind === 'video'
      ? Math.max(1, Math.round(((opts.endSec ?? input.durationSec) - (opts.startSec ?? 0)) * (opts.fps ?? input.fps)))
      : input.frameCount;
  const progress = new FrameProgress(total, onProgress);
  const name = opts.sourceName ?? (input.kind === 'video' ? input.name : 'animation');
  const renderer = new FrameRenderer(engine, plan, alpha, opts.paper, signal);

  engine.resetHistory();
  try {
    let data: ArrayBuffer | Blob;
    let container: VideoContainer;
    if (choice) {
      const job: EncodeJob = { mb: await loadMediabunny(), renderer, progress, signal, warnings };
      container = choice.target.container;
      data = 'kind' in source ? await convertVideo(job, source, choice.target, alpha, opts) : await encodeFrames(job, source, choice.target, alpha);
    } else {
      const mime = realtimeRecorderMime(format);
      if (!mime) {
        throw new ExportError('unsupported', 'This browser can’t encode video. Try a recent Chrome, Edge or Safari, or export a GIF.');
      }
      container = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const why = decodable ? 'this browser has no WebCodecs' : 'this browser can’t decode this video frame by frame';
      warnings.push(`Recorded in real time (${why}), so frame timing may be uneven and audio is not included.`);
      if (container !== format) warnings.push(`This browser can only record ${container.toUpperCase()}; saved as .${container}.`);
      const fps = 'kind' in source ? source.fps : (opts.fps ?? 30);
      data = await recordInRealtime({ renderer, progress, signal, warnings }, source, opts, mime, fps);
    }
    return {
      blob: data instanceof Blob ? data : new Blob([data], { type: `video/${container}` }),
      fileName: exportFileName(name, plan.grid, container),
      width: expected.width,
      height: expected.height,
      warnings,
    };
  } finally {
    renderer.dispose();
    engine.resetHistory();
  }
}
