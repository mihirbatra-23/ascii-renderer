/**
 * Separable resampling of 8-bit RGBA to float planes: exact area (box) filter when shrinking an
 * axis, bilinear when enlarging it (the CPU never upsamples beyond bilinear, docs/ALGORITHM.md §2).
 * Alpha is premultiplied before filtering so transparent pixels never bleed their colour.
 *
 * Public API
 *   resampleLumaAlpha(rgba, w, h, dw, dh)  → Float32Array dw·dh·2: (premultiplied luma 0..1, alpha) pairs
 *   resampleRgbaPremultiplied(rgba, w, h, dw, dh) → Float32Array dw·dh·4 (premultiplied RGB 0..1, alpha)
 */

/** Sparse 1-D filter: entry i's taps are (idx, w)[offset[i] .. offset[i+1]). */
interface Taps1D {
  offset: Int32Array;
  idx: Int32Array;
  w: Float64Array;
}

/** For each output index, the source indices it reads and their weights (summing to 1). */
function gatherTaps(src: number, dst: number): Taps1D {
  const offset = new Int32Array(dst + 1);
  const idx: number[] = [];
  const w: number[] = [];
  const s = src / dst;
  for (let i = 0; i < dst; i++) {
    offset[i] = idx.length;
    if (s >= 1) {
      const a = i * s;
      const b = (i + 1) * s;
      for (let j = Math.floor(a); j < Math.min(src, Math.ceil(b)); j++) {
        const overlap = Math.min(b, j + 1) - Math.max(a, j);
        if (overlap <= 0) continue;
        idx.push(j);
        w.push(overlap / s);
      }
    } else {
      const u = Math.min(src - 1, Math.max(0, (i + 0.5) * s - 0.5));
      const j0 = Math.floor(u);
      const f = u - j0;
      idx.push(j0);
      w.push(1 - f);
      if (f > 0) {
        idx.push(j0 + 1);
        w.push(f);
      }
    }
  }
  offset[dst] = idx.length;
  return { offset, idx: Int32Array.from(idx), w: Float64Array.from(w) };
}

/** The same filter indexed by source: which outputs each source index feeds, and how much. */
function scatterTaps(gather: Taps1D, src: number): Taps1D {
  const dst = gather.offset.length - 1;
  const offset = new Int32Array(src + 1);
  for (const j of gather.idx) offset[j + 1]++;
  for (let j = 0; j < src; j++) offset[j + 1] += offset[j];
  const fill = offset.slice(0, src);
  const idx = new Int32Array(gather.idx.length);
  const w = new Float64Array(gather.idx.length);
  for (let i = 0; i < dst; i++) {
    for (let t = gather.offset[i]; t < gather.offset[i + 1]; t++) {
      const k = fill[gather.idx[t]]++;
      idx[k] = i;
      w[k] = gather.w[t];
    }
  }
  return { offset, idx, w };
}

const cache = new Map<string, Taps1D>();

function cachedTaps(src: number, dst: number, scatter: boolean): Taps1D {
  const key = `${src}>${dst}${scatter ? 's' : 'g'}`;
  let taps = cache.get(key);
  if (!taps) {
    if (cache.size > 32) cache.clear();
    taps = scatter ? scatterTaps(gatherTaps(src, dst), src) : gatherTaps(src, dst);
    cache.set(key, taps);
  }
  return taps;
}

/**
 * Streams the source one row at a time: `filterRow` writes row y's horizontally resampled
 * channels into `hrow`, which is then scattered into the output rows it contributes to. Memory
 * stays at one source row plus the output, whatever the source size.
 */
function separable(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  channels: number,
  filterRow: (y: number, wx: Taps1D, hrow: Float64Array) => void,
): Float32Array {
  const wx = cachedTaps(srcW, dstW, false);
  const wy = cachedTaps(srcH, dstH, true);
  const rowLen = dstW * channels;
  const out = new Float32Array(dstH * rowLen);
  const hrow = new Float64Array(rowLen);
  for (let y = 0; y < srcH; y++) {
    const t0 = wy.offset[y];
    const t1 = wy.offset[y + 1];
    if (t0 === t1) continue;
    filterRow(y, wx, hrow);
    for (let t = t0; t < t1; t++) {
      const base = wy.idx[t] * rowLen;
      const wt = wy.w[t];
      for (let i = 0; i < rowLen; i++) out[base + i] += wt * hrow[i];
    }
  }
  return out;
}

const INV255 = 1 / 255;
const LR = 0.2126 * INV255 * INV255;
const LG = 0.7152 * INV255 * INV255;
const LB = 0.0722 * INV255 * INV255;

export function resampleLumaAlpha(
  rgba: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  return separable(srcW, srcH, dstW, dstH, 2, (y, { offset, idx, w }, hrow) => {
    const row = y * srcW;
    for (let x = 0; x < dstW; x++) {
      let l = 0;
      let a = 0;
      for (let t = offset[x]; t < offset[x + 1]; t++) {
        const i = (row + idx[t]) * 4;
        const wa = w[t] * rgba[i + 3];
        l += wa * (LR * rgba[i] + LG * rgba[i + 1] + LB * rgba[i + 2]);
        a += wa;
      }
      hrow[x * 2] = l;
      hrow[x * 2 + 1] = a * INV255;
    }
  });
}

export function resampleRgbaPremultiplied(
  rgba: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const k = INV255 * INV255;
  return separable(srcW, srcH, dstW, dstH, 4, (y, { offset, idx, w }, hrow) => {
    const row = y * srcW;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = offset[x]; t < offset[x + 1]; t++) {
        const i = (row + idx[t]) * 4;
        const wa = w[t] * rgba[i + 3];
        r += wa * rgba[i];
        g += wa * rgba[i + 1];
        b += wa * rgba[i + 2];
        a += wa;
      }
      const o = x * 4;
      hrow[o] = r * k;
      hrow[o + 1] = g * k;
      hrow[o + 2] = b * k;
      hrow[o + 3] = a * INV255;
    }
  });
}
