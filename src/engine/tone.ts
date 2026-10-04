/**
 * Tone mapping (docs/ALGORITHM.md §3) and auto-levels.
 *
 * Public API
 *   polarityInvert(params)            params.invert XOR (luma(ink) < luma(paper))
 *   effectiveLevels(params, levels)   levels when autoLevels is on, else { black: 0, white: 1 }
 *   toneConstants(params, levels)     → ToneConstants (everything toneMap needs, precomputed)
 *   toneMap(lumPremult, alpha, t)     tone (amount of ink) 0..1 of one analysis pixel
 *   toneMapPlane(la, out, t)          the same over interleaved (lumPremult, alpha) pairs, in bulk
 *   measureLevels(rgba, w, h)         → Levels: p1 / p99 luminance of a ≤ 256 px downsample
 *   bayer8, blueNoise64, toneDither, ...  re-exported from ./dither
 */
import type { Levels, RenderParams } from './types';
import { hexLuma } from './color';
import { resampleLumaAlpha } from './resample';

export { bayer8, blueNoise, blueNoise64, BLUE_NOISE_SIZE, threshold, toneDither } from './dither';

export interface ToneConstants {
  black: number;
  /** 1 / max(white − black, 1e-3). */
  scale: number;
  contrast: number;
  brightness: number;
  gamma: number;
  invert: boolean;
}

export function polarityInvert(params: Pick<RenderParams, 'invert' | 'ink' | 'paper'>): boolean {
  return params.invert !== hexLuma(params.ink) < hexLuma(params.paper);
}

export const IDENTITY_LEVELS: Levels = { black: 0, white: 1 };

export function effectiveLevels(params: Pick<RenderParams, 'autoLevels'>, levels: Levels): Levels {
  return params.autoLevels ? levels : IDENTITY_LEVELS;
}

export function toneConstants(params: RenderParams, levels: Levels): ToneConstants {
  const { black, white } = effectiveLevels(params, levels);
  return {
    black,
    scale: 1 / Math.max(white - black, 1e-3),
    contrast: params.contrast,
    brightness: params.brightness,
    gamma: params.gamma,
    invert: polarityInvert(params),
  };
}

/**
 * `lumPremult` is luma × alpha (what an alpha-premultiplied average yields). Only the visible part
 * is tone-mapped (levels, contrast, brightness, gamma, polarity); the result is then scaled by
 * alpha, so transparent pixels are tone 0 (no ink, i.e. paper) whatever the paper colour, the
 * levels, the tone settings or Invert.
 */
export function toneMap(lumPremult: number, alpha: number, t: ToneConstants): number {
  if (alpha <= 0) return 0;
  let l = (lumPremult / alpha - t.black) * t.scale;
  l = l < 0 ? 0 : l > 1 ? 1 : l;
  l = (l - 0.5) * t.contrast + 0.5 + t.brightness;
  l = l < 0 ? 0 : l > 1 ? 1 : l;
  if (t.gamma !== 1) l = Math.pow(l, t.gamma);
  return alpha * (t.invert ? 1 - l : l);
}

/** Bulk form of toneMap with the constants hoisted (about twice as fast on large planes). */
export function toneMapPlane(la: Float32Array, out: Float32Array, t: ToneConstants): Float32Array {
  const { black, scale, contrast, brightness, gamma, invert } = t;
  for (let i = 0, j = 0; i < out.length; i++, j += 2) {
    const alpha = la[j + 1];
    if (alpha <= 0) {
      out[i] = 0;
      continue;
    }
    let l = (la[j] / alpha - black) * scale;
    l = l < 0 ? 0 : l > 1 ? 1 : l;
    l = (l - 0.5) * contrast + 0.5 + brightness;
    l = l < 0 ? 0 : l > 1 ? 1 : l;
    if (gamma !== 1) l = Math.pow(l, gamma);
    out[i] = alpha * (invert ? 1 - l : l);
  }
  return out;
}

const LEVELS_MAX_EDGE = 256;
/** p99 − p1 is widened to at least this, so a nearly flat image is not blown out to pure black or white. */
const LEVELS_MIN_RANGE = 0.1;
/** Share of the visible pixels clipped at each end (p1 / p99). */
const LEVELS_CLIP = 0.01;
/**
 * A percentile with at least PLATEAU_SHARE of the pixels within ±PLATEAU_BAND of it sits on a flat
 * tone (a logo colour, a flat background), not on the tail of a continuous histogram: twice the
 * share the clip is meant to remove.
 */
const PLATEAU_BAND = 2 / 255;
const PLATEAU_SHARE = 2 * LEVELS_CLIP;
/**
 * A flat tone at the black point may still become paper when it is darker than this fraction of
 * the white point: it reads as background (a dark backdrop vanishing is what auto-levels is
 * for); a lighter one is a colour of the picture and keeps its level. Mirrored at the white point.
 */
const PLATEAU_DARK = 0.25;

/** Number of sorted values ≤ x (inclusive) or < x. */
function rank(sorted: Float32Array, x: number, inclusive: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x || (inclusive && sorted[mid] === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number of sorted values within ±band of v. */
function countNear(sorted: Float32Array, v: number, band: number): number {
  return rank(sorted, v + band, true) - rank(sorted, v - band, false);
}

/**
 * p1 / p99 of the luminance of the visible pixels (alpha ≥ 0.5; transparent ones show the paper,
 * which is not part of the image's exposure). Percentiles are taken symmetrically from a sorted
 * list so the negative of an image gets exactly the mirrored levels.
 *
 * Levels clip tails, never populations: when a percentile lands on a flat tone (a graphic's
 * colour, a flat image) that is not background-dark, clipping there would turn that whole colour
 * into paper, so that end is left unstretched (black = 0, mirrored: white = 1).
 */
export function measureLevels(rgba: ArrayLike<number>, width: number, height: number): Levels {
  const s = Math.min(1, LEVELS_MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const la = resampleLumaAlpha(rgba, width, height, w, h);
  const values = new Float32Array(w * h);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const a = la[i * 2 + 1];
    if (a >= 0.5) values[n++] = la[i * 2] / a;
  }
  if (n === 0) return { ...IDENTITY_LEVELS };
  const sorted = values.subarray(0, n).sort();
  const lo = Math.round(LEVELS_CLIP * (n - 1));
  let black = sorted[lo];
  let white = sorted[n - 1 - lo];
  const plateau = (v: number) => countNear(sorted, v, PLATEAU_BAND) >= PLATEAU_SHARE * n;
  const keepBlack = black > PLATEAU_DARK * white && plateau(black);
  const keepWhite = 1 - white > PLATEAU_DARK * (1 - black) && plateau(white);
  if (keepBlack) black = 0;
  if (keepWhite) white = 1;
  if (white - black < LEVELS_MIN_RANGE) {
    // Place the minimum range so the image's own level maps to itself: a flat grey stays that grey.
    const mid = (black + white) / 2;
    black = mid * (1 - LEVELS_MIN_RANGE);
    white = black + LEVELS_MIN_RANGE;
  }
  return { black, white };
}
