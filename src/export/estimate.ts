import type { AsciiEngine, RenderParams } from '../engine/types';
import type { LoadedAnimation, LoadedVideo } from '../media/types';
import { ExportError } from './errors';
import { sampleGifDeltas, type GifDeltaSample } from './gif-estimate';
import { evenSize, gridPixelSize, normaliseMargin, type PixelSize } from './geometry';
import { sampleMotion, type MotionSource } from './motion';
import { planOutput, readPlanned, type OutputPlan } from './output';
import { RasterWorker } from './raster-worker';
import { realtimeRecorderMime } from './realtime';
import { animationSpans, gifFps, videoFrameTimes } from './timing';
import { snapshotToText } from './txt';
import type { ExportEstimate, ExportOptions } from './types';
import { chooseVideoTarget } from './video-codecs';

/**
 * What the estimate needs to know about the source; any LoadedMedia satisfies it. Given the frames
 * too (LoadedAnimation.readFrame, LoadedVideo.file), GIF and video sizes account for the clip's motion.
 */
export type EstimateMedia =
  | { kind: 'image' }
  | (Pick<LoadedAnimation, 'kind' | 'durations'> & Partial<Pick<LoadedAnimation, 'width' | 'height' | 'readFrame' | 'retain'>>)
  | (Pick<LoadedVideo, 'kind' | 'durationSec' | 'fps' | 'canDecodeFrames' | 'live'> & Partial<Pick<LoadedVideo, 'width' | 'height' | 'file' | 'hasAudio' | 'retain'>>);

/**
 * What a GIF estimate needs to encode real delta frames (gif-estimate.ts): the export's params and
 * a private engine set up like the export's (params, levels, a first frame). The estimate disposes
 * the engine. Without it, GIF sizes come from the clip's measured motion alone (a rougher model).
 */
export interface GifDeltaSampler {
  params: Pick<RenderParams, 'colorMode' | 'ink' | 'paper' | 'shadowInk'>;
  engine(): Promise<AsciiEngine>;
}

/** Sampled delta frames this much apart (high ÷ low clip size) show as a range rather than one figure. */
const RANGE_SPREAD = 1.35;

/** GIFs above this get a note suggesting a smaller scale, fewer frames or MP4. */
export const LARGE_GIF_BYTES = 15 * 1024 * 1024;

/*
 * Size models, fitted on real exports (golden_gate 720p, testsrc2, siri 54 fps portrait, life GIF,
 * aerial, torus, waves, terrain; every mode, mono and source colour; 1–4×). PNGs land within ±35%,
 * video mostly within 2× (motion is measured on a few frame pairs, not every frame). GIFs encode
 * real delta frames when the caller provides a GifDeltaSampler; the motion model below is their
 * fallback.
 * - An ASCII raster's compressed size grows with the length of its glyph edges, so with the scale
 *   (about s^1.3), not with its area (s²): extrapolating by area overstated 4× PNGs 2–3×.
 * - A GIF frame after the first stores only what changed: a share of a full frame that grows with
 *   the clip's motion, plus a floor for cells that flicker (more in source colour).
 * - H.264 / VP9 at 'high' quality spend bits per pixel per frame in proportion to motion, fewer
 *   per pixel at larger sizes; VP9 at this quality spends about twice H.264's.
 */
const SCALE_EXPONENT = 1.3;
const GIF_DELTA = { floor: 0.03, sourceColourFloor: 0.09, perMotion: 2 };
const VIDEO_BITS = { mp4: { base: 0.058, perMotion: 1.25 }, webm: { base: 0.1, perMotion: 4.5 }, sizeExponent: -0.4 };
const AUDIO_BITS_PER_SECOND = 160_000;
/** Assumed share of changing pixels when a clip's motion cannot be measured. */
const TYPICAL_MOTION = 0.03;

function frameCount(media: EstimateMedia, opts: ExportOptions): number | undefined {
  const range = { startSec: opts.startSec, endSec: opts.endSec };
  if (media.kind === 'image') return 1;
  if (media.kind === 'animation') return animationSpans(media.durations, range).length;
  if (media.live) return undefined;
  if (opts.format === 'gif') return videoFrameTimes(media.durationSec, range, gifFps(media.fps, opts.fps)).length;
  const start = Math.max(0, opts.startSec ?? 0);
  const end = Math.min(media.durationSec, opts.endSec ?? media.durationSec);
  return Math.max(1, Math.round((end - start) * (opts.fps ?? media.fps)));
}

/** The clip's measured motion (see motion.ts), or a typical value when the frames are not available. */
async function motionOf(media: EstimateMedia, opts: ExportOptions): Promise<number> {
  const range = { startSec: opts.startSec, endSec: opts.endSec };
  let source: MotionSource | null = null;
  if (media.kind === 'animation' && media.readFrame && media.width && media.height) {
    source = { kind: 'animation', durations: media.durations, width: media.width, height: media.height, readFrame: media.readFrame };
  } else if (media.kind === 'video' && !media.live && media.file && media.width && media.height) {
    source = { kind: 'video', file: media.file, durationSec: media.durationSec, fps: media.fps, width: media.width, height: media.height };
  }
  if (!source) return TYPICAL_MOTION;
  const fps = media.kind === 'video' ? (opts.format === 'gif' ? gifFps(media.fps, opts.fps) : (opts.fps ?? media.fps)) : 0;
  return (await sampleMotion(source, range, fps)) ?? TYPICAL_MOTION;
}

/** Whether the engine renders in source colour (an adaptive GIF palette, more flicker between frames). */
function sourceColour(engine: AsciiEngine): boolean {
  try {
    return engine.snapshot().params.colorMode === 'source';
  } catch {
    return false;
  }
}

function durationSec(media: EstimateMedia, opts: ExportOptions): number {
  if (media.kind === 'image' || (media.kind === 'video' && media.live)) return 0;
  const total = media.kind === 'animation' ? media.durations.reduce((a, b) => a + b, 0) / 1000 : media.durationSec;
  const start = Math.max(0, opts.startSec ?? 0);
  return Math.max(0, Math.min(total, opts.endSec ?? total) - start);
}

/** Exact size of the TXT file (UTF-8: braille and block characters take 3 bytes), from the grid's characters. */
function textBytes(engine: AsciiEngine, opts: ExportOptions): number | undefined {
  try {
    return new TextEncoder().encode(snapshotToText(engine.snapshot(), opts.lineEnding)).length;
  } catch {
    // No frame on the engine yet.
    return undefined;
  }
}

/** Samples are rendered at the largest whole scale up to the export's that stays under this many pixels. */
const SAMPLE_MAX_PIXELS = 1_000_000;

/** The largest whole scale ≤ `scale` whose raster stays under SAMPLE_MAX_PIXELS. */
function sampleScale(engine: AsciiEngine, margin: number, scale: number): number {
  const base = gridPixelSize(engine.getGrid(), engine.getGeometry(), margin);
  return Math.max(1, Math.min(scale, Math.floor(Math.sqrt(SAMPLE_MAX_PIXELS / (base.width * base.height)))));
}

/** Real delta frames of the clip (gif-estimate.ts) on the sampler's private engine; null when they cannot be measured. */
async function gifDeltas(sampler: GifDeltaSampler, media: EstimateMedia, opts: ExportOptions, scale: number, margin: number, signal: AbortSignal | undefined): Promise<GifDeltaSample | null> {
  const range = { startSec: opts.startSec, endSec: opts.endSec };
  let source: Parameters<typeof sampleGifDeltas>[2] | null = null;
  if (media.kind === 'animation' && media.readFrame && media.width && media.height && media.retain) {
    source = { kind: 'animation', durations: media.durations, width: media.width, height: media.height, readFrame: media.readFrame, retain: media.retain };
  } else if (media.kind === 'video' && !media.live && media.file && media.retain) {
    source = { kind: 'video', file: media.file, durationSec: media.durationSec, retain: media.retain };
  }
  if (!source) return null;
  const fps = media.kind === 'video' ? gifFps(media.fps, opts.fps) : 0;
  let engine: AsciiEngine | null = null;
  try {
    engine = await sampler.engine();
    signal?.throwIfAborted();
    return await sampleGifDeltas(engine, sampler.params, source, range, fps, { scale: sampleScale(engine, margin, scale), margin }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A device that cannot render the samples falls back to the motion model.
    return null;
  } finally {
    engine?.dispose();
  }
}

/**
 * Encoded size of the current grid (PNG and one full GIF frame) at the largest whole scale ≤ `scale`
 * that stays under SAMPLE_MAX_PIXELS: read back asynchronously and encoded in a worker.
 */
async function measureSample(engine: AsciiEngine, margin: number, scale: number, signal: AbortSignal | undefined) {
  const plan = planOutput(engine, { scale: sampleScale(engine, margin, scale), margin });
  const pixels = await readPlanned(engine, plan, signal);
  const worker = new RasterWorker();
  try {
    return { ...(await worker.measure(pixels, signal)), measured: plan.rasterSize };
  } finally {
    worker.terminate();
  }
}

/** Bytes of a raster at `size`, from a measurement of the same grid at `measured`. */
function extrapolate(bytesMeasured: number, measured: PixelSize, size: PixelSize): number {
  return Math.round(bytesMeasured * (size.width / measured.width) ** SCALE_EXPONENT);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * What an export will produce, before the user commits: the exact output size from the shared
 * geometry (nothing is rendered for it), the frame count, whether this device/browser can do it,
 * notes worth showing, and a byte estimate for PNG / GIF / video / TXT. PNG and GIF render the grid
 * at the largest whole scale under 1 MP (async readback, encoded in a worker) and extrapolate. With
 * `gifSampler`, a GIF's later frames are measured as real deltas of frame pairs across the clip;
 * otherwise GIF and video sizes follow the clip's measured motion (motion.ts). Nothing here blocks
 * the main thread for long. Pass `signal` to drop a superseded estimate.
 */
export async function estimateExport(
  engine: AsciiEngine,
  media: EstimateMedia,
  opts: ExportOptions,
  signal?: AbortSignal,
  gifSampler?: GifDeltaSampler,
): Promise<ExportEstimate> {
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  const margin = normaliseMargin(opts.margin);
  const notes: string[] = [];
  const live = media.kind === 'video' && media.live === true;

  switch (opts.format) {
    case 'txt':
      return { bytes: textBytes(engine, opts), notes, supported: true };
    case 'html':
    case 'svg': {
      const size = gridPixelSize(grid, geometry, margin);
      return { width: size.width, height: size.height, notes, supported: true };
    }
    default:
      break;
  }

  let plan: OutputPlan;
  try {
    plan = planOutput(engine, opts);
  } catch (error) {
    if (!(error instanceof ExportError)) throw error;
    const base = gridPixelSize(grid, geometry, margin);
    return { width: base.width * Math.max(1, Math.round(opts.scale)), height: base.height * Math.max(1, Math.round(opts.scale)), notes: [error.message], supported: false };
  }
  let size = plan.size;
  if (size.width !== plan.rasterSize.width) notes.push(`Rendered at ${plan.raster.scale}× and resampled to exactly ${size.width} × ${size.height} px.`);
  const frames = frameCount(media, opts);
  const sample = () => measureSample(engine, margin, plan.raster.scale, signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    // Nothing to measure yet (no frame on the engine): the size stays unknown.
    return null;
  });

  if (opts.format === 'png') {
    const sampled = await sample();
    return { ...size, bytes: sampled ? extrapolate(sampled.pngBytes, sampled.measured, size) : undefined, notes, supported: true };
  }

  // Frame-exact export decodes with WebCodecs; some videos only play in the <video> element.
  const decodable = media.kind !== 'video' || (!live && media.canDecodeFrames !== false);
  if (opts.format === 'gif') {
    if (live) {
      notes.push('GIF isn’t available for a camera. Choose MP4 or WebM.');
      return { ...size, notes, supported: false };
    }
    if (!decodable) {
      notes.push('This browser can’t read this video frame by frame. Export MP4 or WebM instead.');
      return { ...size, frames, notes, supported: false };
    }
    let bytes: number | undefined;
    let bytesRange: [number, number] | undefined;
    const deltas = frames && frames > 1 && gifSampler ? await gifDeltas(gifSampler, media, opts, plan.raster.scale, margin, signal) : null;
    if (deltas && frames) {
      // First frame whole, then every later frame at the sampled delta share; both scale like the raster's edges.
      const first = extrapolate(deltas.firstBytes, deltas.measured, size);
      const total = (ratio: number) => Math.round(first * (1 + (frames - 1) * ratio));
      const ratios = deltas.deltaRatios;
      bytes = total(ratios.reduce((a, b) => a + b, 0) / ratios.length);
      const low = total(Math.min(...ratios));
      const high = total(Math.max(...ratios));
      if (high > low * RANGE_SPREAD) bytesRange = [low, high];
    } else {
      const [sampled, motion] = await Promise.all([sample(), motionOf(media, opts)]);
      if (sampled && frames) {
        const first = extrapolate(sampled.gifFrameBytes, sampled.measured, size);
        const delta = (sourceColour(engine) ? GIF_DELTA.sourceColourFloor : GIF_DELTA.floor) + GIF_DELTA.perMotion * motion;
        bytes = Math.round(first * (1 + (frames - 1) * Math.min(1, delta)));
      }
    }
    // Warn on what the file may reach, not only on the middle of the estimate.
    const most = bytesRange?.[1] ?? bytes;
    if (most !== undefined && most > LARGE_GIF_BYTES) notes.push(`${bytesRange ? 'Up to about' : 'About'} ${formatMegabytes(most)}: lower the scale or frame rate, trim the clip, or export MP4 for a smaller file.`);
    return { ...size, frames, bytes, bytesRange, notes, supported: true };
  }

  // mp4 / webm
  const even = evenSize(size);
  if (even.width !== size.width || even.height !== size.height) {
    notes.push(`Padded to ${even.width} × ${even.height} px with the paper color (video needs even dimensions).`);
    size = even;
  }
  let supported = true;
  if (live) {
    if (!realtimeRecorderMime(opts.format)) {
      notes.push('This browser can’t record video. Try a recent Chrome, Edge, Firefox or Safari.');
      supported = false;
    } else {
      notes.push('Recorded in real time until you stop it.');
    }
    return { ...size, notes, supported };
  }
  const alpha = opts.transparentBackground && opts.format === 'webm';
  const choice = decodable ? await chooseVideoTarget(opts.format, size.width, size.height, alpha) : null;
  if (choice?.warning) notes.push(choice.warning);
  if (!choice) {
    if (realtimeRecorderMime(opts.format)) {
      notes.push('This browser will record the video in real time, without audio.');
    } else {
      notes.push('This browser can’t export video. Export a GIF instead.');
      supported = false;
    }
  }
  const container = choice?.target.container ?? opts.format;
  const audio = opts.includeAudio && media.kind === 'video' && media.hasAudio !== false ? AUDIO_BITS_PER_SECOND * durationSec(media, opts) : 0;
  let bytes: number | undefined;
  if (frames) {
    const model = VIDEO_BITS[container];
    const pixels = size.width * size.height;
    const bitsPerPixel = (model.base + model.perMotion * (await motionOf(media, opts))) * (pixels / 1e6) ** VIDEO_BITS.sizeExponent;
    bytes = Math.round((bitsPerPixel * pixels * frames + audio) / 8);
  }
  return { ...size, frames, bytes, notes, supported };
}
