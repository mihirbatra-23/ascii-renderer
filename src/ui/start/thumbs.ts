/**
 * Sample thumbnails: real 72 × 20 renders of the bundled samples, each in its own look, made with
 * the engine's CPU reference (no WebGL context for three small previews) from small copies of the
 * samples (public/samples/thumbs, ~65 KB in all, rather than the full images and the video).
 *
 * They are the same for every visitor, so a finished set is kept in localStorage and later visits
 * draw the tiles at once, with no downloads and no analysis. The key covers everything a
 * thumbnail depends on that can change between deploys (app version, looks, defaults, sources);
 * development builds skip the cache, so engine work always shows fresh tiles.
 *
 *   loadThumb(sample) → Promise<Thumb>   rows of tone runs for the art box (duotone steps --k1…--k5)
 *   peekThumb(sample) → Thumb | undefined   synchronous: cached or already rendered
 */
import { analyzeCpu, toSnapshot } from '../../engine/cpu';
import { duotoneWeight } from '../../engine/rasterCpu';
import { browserCanvasFactory } from '../../engine/canvas';
import { prepareAnalysis, type AnalysisSetup } from '../../engine/setup';
import { FONTS, loadFont, measureLevels } from '../../engine';
import type { RenderParams } from '../../engine/types';
import { defaultParams } from '../../state/params';
import { APP_VERSION, SAMPLES, type Sample } from './samples';

const THUMB_COLS = 72;

/** A run of characters drawn in one duotone step (0 = spaces only, no colour needed). */
export interface ToneRun {
  k: 0 | 1 | 2 | 3 | 4 | 5;
  text: string;
}

export type Thumb = readonly (readonly ToneRun[])[];

// Thumbnails are a fixed showcase, so they use the app defaults, not the user's current params.
const PARAMS = { ...defaultParams(), columns: THUMB_COLS };

const CACHE_KEY = 'ascii-renderer:thumbs';
/** Everything the stored thumbnails were made from; any difference discards them. */
const CACHE_STAMP = JSON.stringify([APP_VERSION, THUMB_COLS, PARAMS, SAMPLES.map((s) => [s.url, s.thumbUrl, s.look])]);
const CACHE_ON = !import.meta.env.DEV;

const pending = new Map<string, Promise<Thumb>>();
const done = new Map<string, Thumb>(Object.entries(readCache()));
/** Glyph sets per sample charset (a look may use its own, e.g. the video's short ramp). */
const setups = new Map<string, Promise<AnalysisSetup>>();

export function peekThumb(sample: Sample): Thumb | undefined {
  return done.get(sample.url);
}

export function loadThumb(sample: Sample): Promise<Thumb> {
  const ready = done.get(sample.url);
  if (ready) return Promise.resolve(ready);
  let p = pending.get(sample.url);
  if (!p) {
    p = idle()
      .then(() => renderThumb(sample))
      .then((thumb) => {
        done.set(sample.url, thumb);
        writeCache();
        return thumb;
      });
    // A failed sample may be retried on the next visit to the start screen.
    p.catch(() => pending.delete(sample.url));
    pending.set(sample.url, p);
  }
  return p;
}

// ---------------------------------------------------------------- cache across sessions

function readCache(): Record<string, Thumb> {
  if (!CACHE_ON) return {};
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return {};
    const { stamp, thumbs } = data as { stamp?: unknown; thumbs?: unknown };
    if (stamp !== CACHE_STAMP || !thumbs || typeof thumbs !== 'object') return {};
    return Object.fromEntries(Object.entries(thumbs).filter(([, t]) => isThumb(t))) as Record<string, Thumb>;
  } catch {
    return {};
  }
}

function writeCache(): void {
  if (!CACHE_ON || done.size < SAMPLES.length) return;
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ stamp: CACHE_STAMP, thumbs: Object.fromEntries(done) }));
  } catch {
    // Storage full or blocked: the tiles are simply rendered again next time.
  }
}

/** Stored data is untrusted: only well-formed rows of runs are drawn. */
function isThumb(value: unknown): value is Thumb {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.every((run) => !!run && typeof run === 'object' && typeof run.text === 'string' && Number.isInteger(run.k) && run.k >= 0 && run.k <= 5),
    )
  );
}

// ---------------------------------------------------------------- rendering

/** Yield to first paint and user input; the glyph set build is the one heavy step. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 600 });
    else setTimeout(resolve, 50);
  });
}

function analysisSetup(params: RenderParams): Promise<AnalysisSetup> {
  const key = `${params.charsetPreset}\u0000${params.customCharset}`;
  let setup = setups.get(key);
  if (!setup) {
    setup = loadFont(params.font).then(() => prepareAnalysis(params, FONTS[params.font].family, browserCanvasFactory));
    setups.set(key, setup);
  }
  return setup;
}

async function renderThumb(sample: Sample): Promise<Thumb> {
  const params: RenderParams = { ...PARAMS, ...sample.look };
  const [{ geometry, glyphSet, taps }, pixels] = await Promise.all([analysisSetup(params), samplePixels(sample.thumbUrl)]);
  const levels = measureLevels(pixels.data, pixels.width, pixels.height);
  const result = analyzeCpu({ rgba: pixels.data, width: pixels.width, height: pixels.height }, params, levels, geometry, glyphSet, taps);
  const { cols, rows, chars, tone } = toSnapshot(result, glyphSet, params, geometry);
  return Array.from({ length: rows }, (_, r) => toneRuns(chars, tone, r * cols, cols));
}

/** The editor's duotone mix weight (ALGORITHM §7), split into the boards' five colour steps. */
function toneClass(L: number): ToneRun['k'] {
  return (1 + Math.min(4, Math.floor(duotoneWeight(L) * 5))) as ToneRun['k'];
}

function toneRuns(chars: readonly string[], tone: Float32Array, start: number, cols: number): ToneRun[] {
  const runs: ToneRun[] = [];
  let cur: ToneRun | undefined;
  for (let i = start; i < start + cols; i++) {
    const ch = chars[i];
    // Spaces extend the current run, which keeps the span count low.
    const k = ch === ' ' ? (cur?.k ?? 0) : toneClass(tone[i]);
    if (!cur || cur.k !== k) runs.push((cur = { k, text: ch }));
    else cur.text += ch;
  }
  return runs;
}

/** The thumbnail source at the analysis width (8 px per column; the engine resamples from there). */
async function samplePixels(url: string): Promise<ImageData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const width = THUMB_COLS * 8;
    const height = Math.round((width * bitmap.height) / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}
