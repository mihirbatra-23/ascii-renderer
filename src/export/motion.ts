/**
 * How much of a clip's picture changes from one frame to the next, measured on a few pairs of
 * consecutive frames spread across the trim range at thumbnail size. Animated file sizes follow it
 * (an inter-frame-delta GIF stores only what changed; a video encoder spends its bits on motion), so
 * the export estimate uses it instead of guessing. Frames are decoded for the measurement alone and
 * the comparison is done on 64 px copies, so it costs a few milliseconds of main-thread time.
 */
import type { LoadedAnimation, LoadedVideo } from '../media/types';
import { animationSpans, clampRange, type TimeRange } from './timing';

/** Width of the copies compared (height follows the aspect). */
const PROBE_WIDTH = 64;
/** Pairs of consecutive frames measured. */
const PAIRS = 4;
/** A pixel counts as changed when its luma moves by more than this (0..255): about one tone step of a grid cell. */
const CHANGE_THRESHOLD = 8;

type Drawable = CanvasImageSource & { width: number; height: number };

function lumaOf(frame: Drawable, width: number, height: number): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
  ctx.drawImage(frame, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const luma = new Uint8Array(width * height);
  for (let p = 0; p < luma.length; p++) luma[p] = (54 * rgba[p * 4] + 183 * rgba[p * 4 + 1] + 19 * rgba[p * 4 + 2]) >> 8;
  return luma;
}

/** Share of pixels whose luma differs by more than the threshold. */
function changedFraction(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > CHANGE_THRESHOLD) changed++;
  return a.length ? changed / a.length : 0;
}

function probeSize(width: number, height: number): { width: number; height: number } {
  return { width: PROBE_WIDTH, height: Math.max(1, Math.round((PROBE_WIDTH * height) / width)) };
}

async function animationMotion(anim: Pick<LoadedAnimation, 'durations' | 'width' | 'height' | 'readFrame'>, range: TimeRange): Promise<number | null> {
  const spans = animationSpans(anim.durations, range);
  if (spans.length < 2) return 0;
  const size = probeSize(anim.width, anim.height);
  const fractions: number[] = [];
  const pairs = Math.min(PAIRS, spans.length - 1);
  for (let k = 0; k < pairs; k++) {
    const at = Math.floor(((k + 0.5) * (spans.length - 1)) / pairs);
    const [a, b] = await Promise.all([anim.readFrame(spans[at][0]), anim.readFrame(spans[at + 1][0])]);
    try {
      fractions.push(changedFraction(lumaOf(a, size.width, size.height), lumaOf(b, size.width, size.height)));
    } finally {
      a.close();
      b.close();
    }
  }
  return fractions.reduce((s, f) => s + f, 0) / fractions.length;
}

async function videoMotion(video: Pick<LoadedVideo, 'file' | 'durationSec' | 'fps' | 'width' | 'height'>, range: TimeRange, fps: number): Promise<number | null> {
  const { start, end } = clampRange(range, video.durationSec);
  const step = 1 / fps;
  if (end - start <= step) return 0;
  const times: number[] = [];
  for (let k = 0; k < PAIRS; k++) {
    const t = start + ((k + 0.5) * (end - start - step)) / PAIRS;
    times.push(t, t + step);
  }
  const size = probeSize(video.width, video.height);
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'fill', poolSize: 2 });
    const lumas: Array<Uint8Array | null> = [];
    for await (const wrapped of sink.canvasesAtTimestamps(times)) lumas.push(wrapped ? lumaOf(wrapped.canvas, size.width, size.height) : null);
    const fractions: number[] = [];
    for (let i = 0; i + 1 < lumas.length; i += 2) {
      const a = lumas[i];
      const b = lumas[i + 1];
      if (a && b) fractions.push(changedFraction(a, b));
    }
    return fractions.length ? fractions.reduce((s, f) => s + f, 0) / fractions.length : null;
  } finally {
    input.dispose();
  }
}

/** What sampleMotion can measure: an animation with readFrame, or a video with its file. */
export type MotionSource =
  | ({ kind: 'animation' } & Pick<LoadedAnimation, 'durations' | 'width' | 'height' | 'readFrame'>)
  | ({ kind: 'video' } & Pick<LoadedVideo, 'file' | 'durationSec' | 'fps' | 'width' | 'height'>);

const cache = new WeakMap<object, Map<string, Promise<number | null>>>();

/**
 * Mean share of pixels that change between consecutive frames (0..1) inside `range`, with frames
 * `1 / fps` apart for video (the export's rate); null when no pair could be decoded. Cached per
 * media, range and rate: it does not depend on the render settings.
 */
export function sampleMotion(media: MotionSource, range: TimeRange, fps: number): Promise<number | null> {
  let byKey = cache.get(media);
  if (!byKey) cache.set(media, (byKey = new Map()));
  const key = `${range.startSec ?? ''}|${range.endSec ?? ''}|${media.kind === 'video' ? fps : ''}`;
  let motion = byKey.get(key);
  if (!motion) {
    motion = (media.kind === 'animation' ? animationMotion(media, range) : videoMotion(media, range, fps)).catch(() => null);
    byKey.set(key, motion);
  }
  return motion;
}
