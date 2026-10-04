import type { RenderParams } from '../engine/types';
import { mix, parseHex, unpack } from './color';

export type Palette = number[][];

/** Browsers stretch delays under 2 cs (20 ms) to 100 ms, so no frame may be shorter. */
export const MIN_GIF_DELAY_CS = 2;

/**
 * Converts frame durations (ms) to GIF centiseconds without drift: each frame gets the rounded
 * cumulative end time minus what has already been emitted, so rounding error is carried forward
 * instead of accumulating (e.g. 30 fps → 3,4,3,3,4,3… cs, exact over the clip).
 */
export class DelayAccumulator {
  private totalMs = 0;
  private emittedCs = 0;

  next(durationMs: number): number {
    this.totalMs += Math.max(0, durationMs);
    const cs = Math.max(MIN_GIF_DELAY_CS, Math.round(this.totalMs / 10) - this.emittedCs);
    this.emittedCs += cs;
    return cs;
  }
}

/** Palette strategy: fixed for ink/paper renders, one adaptive global palette for source colour. */
export function usesFixedPalette(params: Pick<RenderParams, 'colorMode'>): boolean {
  return params.colorMode !== 'source';
}

/**
 * Fixed palette (≤ 32 entries) covering every colour a mono or duotone render can produce: each
 * glyph colour blended with the paper at several coverage levels (anti-aliased edges). Built once,
 * so the same pixel maps to the same index in every frame and nothing shimmers.
 */
export function fixedPalette(params: Pick<RenderParams, 'colorMode' | 'ink' | 'paper' | 'shadowInk'>): Palette {
  const paper = parseHex(params.paper);
  const ink = parseHex(params.ink);
  const shadow = parseHex(params.shadowInk);
  const colors = new Set<number>([paper]);
  if (params.colorMode === 'duotone') {
    const tints = 6;
    const coverages = 5;
    for (let t = 0; t < tints; t++) {
      const glyph = mix(shadow, ink, t / (tints - 1));
      for (let a = 1; a <= coverages; a++) colors.add(mix(paper, glyph, a / coverages));
    }
  } else {
    const levels = 16;
    for (let a = 1; a < levels; a++) colors.add(mix(paper, ink, a / (levels - 1)));
  }
  return [...colors].map(unpack);
}

/** Forces the palette entry nearest to `color` to be exactly `color` (the paper must never drift). */
export function snapToPalette(palette: Palette, color: [number, number, number]): Palette {
  let best = 0;
  let bestDist = Infinity;
  palette.forEach((p, i) => {
    const d = (p[0] - color[0]) ** 2 + (p[1] - color[1]) ** 2 + (p[2] - color[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  const out = palette.map((p) => p.slice(0, 3));
  if (out.length === 0) out.push([...color]);
  else out[best] = [...color];
  return out;
}

/** Copies every `stride`-th pixel so a palette can be quantized from a bounded sample of a frame. */
export function samplePixels(rgba: Uint8Array | Uint8ClampedArray, maxPixels: number): Uint8Array {
  const pixels = rgba.length / 4;
  const stride = Math.max(1, Math.ceil(pixels / maxPixels));
  const out = new Uint8Array(Math.ceil(pixels / stride) * 4);
  for (let p = 0, o = 0; p < pixels; p += stride, o += 4) {
    out[o] = rgba[p * 4];
    out[o + 1] = rgba[p * 4 + 1];
    out[o + 2] = rgba[p * 4 + 2];
    out[o + 3] = 255;
  }
  return out;
}

/** Colours are cached per 6-bit-per-channel bin (262 144 bins). */
const BIN_BITS = 6;
const UNMAPPED = 0xffff;

/**
 * Maps RGBA pixels to palette indices for every frame of one GIF. The index of a colour depends only
 * on its bin, never on which pixels came first, so an unchanged pixel keeps its index from frame to
 * frame: colours cannot shimmer, and the inter-frame delta sees exactly the pixels that changed. A
 * palette colour maps to itself (its bin is seeded with it), and `preferred` (the paper) wins its bin
 * so the background never drifts; other bins take the entry nearest the bin's centre.
 */
export class PaletteMapper {
  private readonly cache = new Uint16Array(1 << (3 * BIN_BITS)).fill(UNMAPPED);
  private out = new Uint8Array(0);

  constructor(
    private readonly palette: Palette,
    preferred?: readonly [number, number, number],
  ) {
    if (palette.length < 1 || palette.length > 256) throw new RangeError(`A GIF palette holds 1–256 colours (got ${palette.length}).`);
    palette.forEach((c, i) => {
      this.cache[binOf(c[0], c[1], c[2])] = i;
    });
    if (preferred) {
      const i = palette.findIndex((c) => c[0] === preferred[0] && c[1] === preferred[1] && c[2] === preferred[2]);
      if (i >= 0) this.cache[binOf(preferred[0], preferred[1], preferred[2])] = i;
    }
  }

  /** Indices of `rgba`'s pixels (alpha ignored), in a buffer reused by the next call. */
  map(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
    const n = rgba.length >> 2;
    if (this.out.length !== n) this.out = new Uint8Array(n);
    const { cache, out } = this;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const key = binOf(rgba[i], rgba[i + 1], rgba[i + 2]);
      let index = cache[key];
      if (index === UNMAPPED) index = cache[key] = this.nearest(key);
      out[p] = index;
    }
    return out;
  }

  private nearest(key: number): number {
    const mask = (1 << BIN_BITS) - 1;
    const half = 1 << (7 - BIN_BITS);
    const r = ((key >> (2 * BIN_BITS)) << (8 - BIN_BITS)) + half;
    const g = (((key >> BIN_BITS) & mask) << (8 - BIN_BITS)) + half;
    const b = ((key & mask) << (8 - BIN_BITS)) + half;
    let best = 0;
    let bestDist = Infinity;
    this.palette.forEach((c, i) => {
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }
}

function binOf(r: number, g: number, b: number): number {
  const shift = 8 - BIN_BITS;
  return ((r >> shift) << (2 * BIN_BITS)) | ((g >> shift) << BIN_BITS) | (b >> shift);
}

/**
 * The global colour table for a delta-encoded GIF: the palette plus one reserved entry (the paper
 * colour, never mapped to) whose index marks unchanged pixels.
 */
export function withTransparentSlot(palette: Palette, paper: [number, number, number]): { table: Palette; transparentIndex: number } {
  if (palette.length > 255) throw new RangeError('The palette needs a free slot for the transparent index (≤ 255 colours).');
  return { table: [...palette.map((c) => c.slice(0, 3)), [...paper]], transparentIndex: palette.length };
}
