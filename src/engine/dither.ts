/**
 * Screen-locked threshold patterns (docs/ALGORITHM.md §5, §6). Never time-varying, so they are safe
 * for video.
 *
 * Public API
 *   bayer8(x, y)          ordered 8×8 threshold in (0, 1): (B8[y%8][x%8] + 0.5) / 64
 *   BLUE_NOISE_SIZE       64
 *   blueNoise64()         Float32Array(64·64) of thresholds in (0, 1), row-major (built once, cached)
 *   blueNoise(x, y)       tiled lookup into blueNoise64()
 *   threshold(pattern, x, y)  the braille / blocks threshold for a sub-cell at global coordinate (x, y)
 *   toneNoise(col, row)   the cell-locked noise of the shape / ramp tone dither (§5)
 *   toneDither(t, noise, amount)  shape / ramp tone dither that never leaves [0, 1] (§5)
 */
import type { DitherPattern } from './types';

const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const B8 = (() => {
  // Standard recursive construction: B8[y][x] = 4·B4[y%4][x%4] + B2[y/4][x/4].
  const b2 = [0, 2, 3, 1];
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      out[y * 8 + x] = 4 * B4[(y & 3) * 4 + (x & 3)] + b2[(y >> 2) * 2 + (x >> 2)];
    }
  }
  return out;
})();

export function bayer8(x: number, y: number): number {
  return (B8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
}

export const BLUE_NOISE_SIZE = 64;

let blueNoiseTile: Float32Array | null = null;

export function blueNoise64(): Float32Array {
  blueNoiseTile ??= voidAndCluster(BLUE_NOISE_SIZE, 1.5, 0x9e3779b9);
  return blueNoiseTile;
}

export function blueNoise(x: number, y: number): number {
  const n = BLUE_NOISE_SIZE;
  return blueNoise64()[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
}

export function threshold(pattern: DitherPattern, x: number, y: number): number {
  if (pattern === 'ordered') return bayer8(x, y);
  if (pattern === 'noise') return blueNoise(x, y);
  return 0.5;
}

/**
 * Noise value of cell (col, row) for the shape / ramp tone dither: the blue-noise tile, so the
 * residual texture is aperiodic grain. (A 4×4 Bayer matrix has a strong period-2 component that
 * alternates neighbouring glyphs into regular 'UXUX' / 'V|V|' hatching across smooth gradients;
 * measured over 8 images at equal banding, blue noise halves that alternation.)
 */
export function toneNoise(col: number, row: number): number {
  return blueNoise(col, row);
}

/**
 * §5 tone dither: the cell-locked offset (noise − 0.5)·amount, its amplitude limited to
 * 2·min(t, 1 − t) so that t + offset never leaves [0, 1]. Nothing is ever clipped, so the dither
 * adds no ink on average, and exact black and white stay exact (no dot lattice over a black
 * background, no holes in a white one).
 */
export function toneDither(t: number, noise: number, amount: number): number {
  return t + (noise - 0.5) * Math.max(0, Math.min(amount, 2 * t, 2 - 2 * t));
}

/** mulberry32: tiny deterministic PRNG so the tile is identical on every run and device. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ulichney's void-and-cluster on an n×n torus. Returns ranks scaled to thresholds in (0, 1).
 * Energy is a toroidal Gaussian of the minority pixels; ties resolve to the lowest index, so the
 * result is fully deterministic.
 */
function voidAndCluster(n: number, sigma: number, seed: number): Float32Array {
  const size = n * n;
  const kernel = new Float64Array(size);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.min(x, n - x);
      const dy = Math.min(y, n - y);
      kernel[y * n + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
  const pattern = new Uint8Array(size);
  const energy = new Float64Array(size);
  const mask = n - 1; // n is a power of two, so wrap-around is a bit mask
  const splat = (p: number, sign: number) => {
    const px = p & mask;
    const py = (p / n) | 0;
    for (let y = 0; y < n; y++) {
      const ky = ((y - py) & mask) * n;
      const row = y * n;
      for (let x = 0; x < n; x++) energy[row + x] += sign * kernel[ky + ((x - px) & mask)];
    }
  };
  // Tightest cluster: max energy among set pixels; largest void: min energy among unset pixels.
  const extreme = (want: number, max: boolean) => {
    let best = -1;
    let bestE = max ? -Infinity : Infinity;
    for (let i = 0; i < size; i++) {
      if (pattern[i] !== want) continue;
      if (max ? energy[i] > bestE : energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  const random = rng(seed);
  const initial = Math.floor(size / 10);
  for (let placed = 0; placed < initial; ) {
    const p = Math.floor(random() * size);
    if (pattern[p]) continue;
    pattern[p] = 1;
    splat(p, 1);
    placed++;
  }
  // Relax the random seed pattern until moving the tightest cluster into the largest void is a no-op.
  for (;;) {
    const cluster = extreme(1, true);
    pattern[cluster] = 0;
    splat(cluster, -1);
    const voidIdx = extreme(0, false);
    pattern[voidIdx] = 1;
    splat(voidIdx, 1);
    if (voidIdx === cluster) break;
  }

  const rank = new Int32Array(size);
  const proto = pattern.slice();
  const protoEnergy = energy.slice();
  // Phase 1: rank the prototype's pixels by removing tightest clusters.
  for (let r = initial - 1; r >= 0; r--) {
    const cluster = extreme(1, true);
    pattern[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = r;
  }
  // Phase 2: fill the largest voids up to half the tile.
  pattern.set(proto);
  energy.set(protoEnergy);
  for (let r = initial; r < size / 2; r++) {
    const voidIdx = extreme(0, false);
    pattern[voidIdx] = 1;
    splat(voidIdx, 1);
    rank[voidIdx] = r;
  }
  // Phase 3: the minority is now the unset pixels; rebuild their energy and fill the tightest clusters of 0s.
  energy.fill(0);
  for (let i = 0; i < size; i++) if (!pattern[i]) splat(i, 1);
  for (let r = size / 2; r < size; r++) {
    const cluster = extreme(0, true);
    pattern[cluster] = 1;
    splat(cluster, -1);
    rank[cluster] = r;
  }
  return Float32Array.from(rank, (r) => (r + 0.5) / size);
}
