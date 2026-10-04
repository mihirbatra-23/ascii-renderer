/**
 * GIF size from real delta frames. A GIF stores its first frame whole and every later frame as the
 * changed rectangle with a transparent index for the unchanged pixels inside it, so its size depends
 * on how the *rendered grid* changes, which a measure of the source's motion predicted only within
 * 0.4–2.6×. Here pairs of consecutive output frames, spread across the range, are rendered on
 * a private engine set up like the export's (same params and levels, a few frames of history before
 * each pair), and encoded in a worker exactly as the GIF exporter encodes them; the clip's size is
 * extrapolated from those bytes.
 *
 *   sampleGifDeltas(engine, params, media, range, fps, sample, signal) → GifDeltaSample | null
 *
 * The engine is the caller's (it is not disposed here); its source and history are overwritten.
 */
import type { AsciiEngine, RasterPixels, RenderParams, SourceInfo } from '../engine/types';
import type { LoadedAnimation, LoadedVideo } from '../media/types';
import { parseHex, unpack } from './color';
import type { FrameInput } from './frames';
import type { PixelSize } from './geometry';
import { fixedPalette, usesFixedPalette } from './gif-palette';
import { planOutput, readPlanned } from './output';
import { RasterWorker } from './raster-worker';
import { animationSpans, clampRange, type TimeRange } from './timing';

/** Pairs of consecutive output frames encoded (spread evenly across the range). */
const PAIRS = 6;
/**
 * Output frames rendered before each pair: the export renders with §8 temporal history, so a pair
 * measured from a cold history changes fewer cells than the same frames deep into the clip.
 */
const WARMUP = 3;

export interface GifDeltaSample {
  /** Mean bytes of a first (whole) frame at `measured`. */
  firstBytes: number;
  /** Each pair's delta-frame bytes as a share of its first frame's. */
  deltaRatios: number[];
  /** The raster size the pairs were rendered at. */
  measured: PixelSize;
}

/** The scale and margin of the sample renders (a whole scale small enough to be cheap). */
export interface GifSampleRaster {
  scale: number;
  margin: number;
}

type DeltaMedia = Pick<LoadedAnimation, 'kind' | 'durations' | 'width' | 'height' | 'readFrame' | 'retain'> | Pick<LoadedVideo, 'kind' | 'file' | 'durationSec' | 'retain'>;

/** A frame of a run: `left` frames follow it in the same run (1 = the pair's first, 0 = its second). */
interface RunFrame extends FrameInput {
  left: number;
}

/**
 * Runs of consecutive output frames, ending in a measured pair, at PAIRS places spread across the
 * range (in order). A run near the start has fewer warm-up frames.
 */
async function* frameRuns(media: DeltaMedia, range: TimeRange, fps: number): AsyncGenerator<RunFrame> {
  const release = media.retain();
  try {
    if (media.kind === 'animation') {
      const spans = animationSpans(media.durations, range);
      if (spans.length < 2) return;
      const info: SourceInfo = { width: media.width, height: media.height, animated: true };
      const pairs = Math.min(PAIRS, spans.length - 1);
      for (let k = 0; k < pairs; k++) {
        const i = Math.floor(((k + 0.5) * (spans.length - 1)) / pairs);
        const from = Math.max(0, i - WARMUP);
        for (let j = from; j <= i + 1; j++) {
          const frame = await media.readFrame(spans[j][0]);
          try {
            yield { source: frame, info, left: i + 1 - j };
          } finally {
            frame.close();
          }
        }
      }
      return;
    }
    const { start, end } = clampRange(range, media.durationSec);
    const step = 1 / fps;
    if (end - start <= step) return;
    const runs: number[][] = [];
    for (let k = 0; k < PAIRS; k++) {
      const t = start + ((k + 0.5) * (end - start - step)) / PAIRS;
      const run: number[] = [];
      for (let j = -WARMUP; j <= 1; j++) if (t + j * step >= start - 1e-6) run.push(t + j * step);
      runs.push(run);
    }
    // Loaded on demand so Mediabunny stays out of the app's initial bundle.
    const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(media.file), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return;
      const info: SourceInfo = { width: track.displayWidth, height: track.displayHeight, animated: true };
      const sink = new CanvasSink(track, { poolSize: 2 });
      for (const run of runs) {
        let previous: HTMLCanvasElement | OffscreenCanvas | null = null;
        let left = run.length - 1;
        for await (const wrapped of sink.canvasesAtTimestamps(run)) {
          // A time the decoder cannot serve repeats the previous frame (as a player would show it).
          const canvas: HTMLCanvasElement | OffscreenCanvas | null = wrapped?.canvas ?? previous;
          if (canvas) yield { source: canvas, info, left };
          previous = canvas;
          left--;
        }
      }
    } finally {
      input.dispose();
    }
  } finally {
    release();
  }
}

/**
 * Renders and encodes the pairs. Null when the range holds a single frame (no delta to measure) or
 * no pair could be decoded. Rejects with an AbortError once `signal` aborts.
 */
export async function sampleGifDeltas(
  engine: AsciiEngine,
  params: Pick<RenderParams, 'colorMode' | 'ink' | 'paper' | 'shadowInk'>,
  media: DeltaMedia,
  range: TimeRange,
  fps: number,
  sample: GifSampleRaster,
  signal?: AbortSignal,
): Promise<GifDeltaSample | null> {
  const plan = planOutput(engine, sample);
  const palette = usesFixedPalette(params) ? fixedPalette(params) : null;
  const paper = unpack(parseHex(params.paper));
  const worker = new RasterWorker();
  const firsts: number[] = [];
  const deltaRatios: number[] = [];
  try {
    let first: RasterPixels | null = null;
    let fresh = true;
    for await (const frame of frameRuns(media, range, fps)) {
      signal?.throwIfAborted();
      // Each run starts from a clean history and renders in order, as the export does.
      if (fresh) engine.resetHistory();
      fresh = frame.left === 0;
      engine.setSource(frame.source, frame.info);
      const pixels = await readPlanned(engine, plan, signal);
      if (frame.left === 1) first = pixels;
      if (frame.left !== 0 || !first) continue;
      const bytes = await worker.gifPair(first, pixels, palette, paper, signal);
      firsts.push(bytes.firstBytes);
      deltaRatios.push(bytes.deltaBytes / bytes.firstBytes);
      first = null;
    }
  } finally {
    worker.terminate();
  }
  if (!deltaRatios.length) return null;
  return { firstBytes: firsts.reduce((a, b) => a + b, 0) / firsts.length, deltaRatios, measured: plan.rasterSize };
}
