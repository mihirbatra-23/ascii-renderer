/**
 * High-quality shrinking of RGBA rasters for exact-width exports (ExportOptions.targetWidth). Pure,
 * so it runs in workers and in unit tests.
 *
 * The filter is an exact area average (every source pixel contributes the fraction of it that each
 * output pixel covers), computed in linear light on premultiplied alpha: averaging gamma-encoded
 * values would darken light glyph strokes on dark paper, and straight alpha would bleed the colour
 * of transparent pixels into the edges. Rows stream through two accumulators, so memory stays at a
 * few rows whatever the size.
 */
import type { RasterPixels } from '../engine/types';
import type { PixelSize } from './geometry';

/** Pixels in a buffer of their own (transferable, and accepted by ImageData). */
export type OwnedPixels = RasterPixels & { data: Uint8ClampedArray<ArrayBuffer> };

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear [0, 1] → sRGB byte through a 4096-step table (finer than any 8-bit step). */
const LINEAR_STEPS = 4095;
const LINEAR_TO_SRGB = new Uint8Array(LINEAR_STEPS + 1);
for (let i = 0; i <= LINEAR_STEPS; i++) {
  const c = i / LINEAR_STEPS;
  LINEAR_TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

/** Per output index: the first source index it covers and the coverage of each covered source pixel. */
interface Taps {
  start: Int32Array;
  count: Int32Array;
  weights: Float32Array;
  /** Stride of `weights` per output index. */
  stride: number;
}

/** Area-coverage taps for shrinking `src` samples to `dst` (dst ≤ src). Weights of each output sum to 1. */
export function areaTaps(src: number, dst: number): Taps {
  const ratio = src / dst;
  const stride = Math.ceil(ratio) + 1;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const weights = new Float32Array(dst * stride);
  for (let o = 0; o < dst; o++) {
    const lo = o * ratio;
    const hi = Math.min(src, (o + 1) * ratio);
    const first = Math.floor(lo);
    let n = 0;
    for (let s = first; s < hi && n < stride; s++, n++) {
      weights[o * stride + n] = (Math.min(hi, s + 1) - Math.max(lo, s)) / ratio;
    }
    start[o] = first;
    count[o] = n;
  }
  return { start, count, weights, stride };
}

/** Shrinks `src` to `size` (each side ≤ the source's). Equal sizes return a copy. */
export function resampleArea(src: RasterPixels, size: PixelSize): OwnedPixels {
  const { width: sw, height: sh, data } = src;
  const { width: dw, height: dh } = size;
  if (dw > sw || dh > sh || dw < 1 || dh < 1) {
    throw new RangeError(`Can only shrink a raster (${sw} × ${sh} → ${dw} × ${dh}).`);
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (dw === sw && dh === sh) {
    out.set(data);
    return { width: dw, height: dh, data: out };
  }
  const xt = areaTaps(sw, dw);
  const yt = areaTaps(sh, dh);
  // Which output rows each source row feeds, inverted from the vertical taps.
  const rowOut: Array<Array<[number, number]>> = Array.from({ length: sh }, () => []);
  for (let o = 0; o < dh; o++) {
    for (let k = 0; k < yt.count[o]; k++) rowOut[yt.start[o] + k].push([o, yt.weights[o * yt.stride + k]]);
  }

  // Premultiplied linear RGB + alpha per output column, for the source row being read and for the
  // output rows it contributes to (a source row feeds at most two output rows when shrinking).
  const row = new Float32Array(dw * 4);
  const acc = new Map<number, Float32Array>();
  for (let sy = 0; sy < sh; sy++) {
    row.fill(0);
    const base = sy * sw * 4;
    for (let o = 0; o < dw; o++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const first = xt.start[o];
      for (let k = 0; k < xt.count[o]; k++) {
        const i = base + (first + k) * 4;
        const w = xt.weights[o * xt.stride + k];
        const wa = (w * data[i + 3]) / 255;
        r += SRGB_TO_LINEAR[data[i]] * wa;
        g += SRGB_TO_LINEAR[data[i + 1]] * wa;
        b += SRGB_TO_LINEAR[data[i + 2]] * wa;
        a += wa;
      }
      row[o * 4] = r;
      row[o * 4 + 1] = g;
      row[o * 4 + 2] = b;
      row[o * 4 + 3] = a;
    }
    for (const [oy, w] of rowOut[sy]) {
      let target = acc.get(oy);
      if (!target) acc.set(oy, (target = new Float32Array(dw * 4)));
      for (let i = 0; i < target.length; i++) target[i] += row[i] * w;
      // The last source row of an output row completes it.
      if (yt.start[oy] + yt.count[oy] - 1 === sy) {
        writeRow(target, out, oy * dw * 4);
        acc.delete(oy);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Un-premultiplies one accumulated row back to straight-alpha sRGB bytes. */
function writeRow(acc: Float32Array, out: Uint8ClampedArray, offset: number): void {
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3];
    const o = offset + i;
    if (a <= 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    out[o] = LINEAR_TO_SRGB[Math.min(LINEAR_STEPS, Math.round((acc[i] / a) * LINEAR_STEPS))];
    out[o + 1] = LINEAR_TO_SRGB[Math.min(LINEAR_STEPS, Math.round((acc[i + 1] / a) * LINEAR_STEPS))];
    out[o + 2] = LINEAR_TO_SRGB[Math.min(LINEAR_STEPS, Math.round((acc[i + 2] / a) * LINEAR_STEPS))];
    out[o + 3] = Math.round(Math.min(1, a) * 255);
  }
}
