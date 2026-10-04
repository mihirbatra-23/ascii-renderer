/**
 * Edge layer (docs/ALGORITHM.md §5b), after Acerola's ASCII shader: a difference of Gaussians
 * isolates edges and thin lines from smooth shading, a Sobel operator on it gives each analysis
 * pixel an orientation, and a cell whose pixels agree on one strong orientation is drawn as that
 * stroke ('|' '/' '\' '-' '_') instead of its fill glyph. DOM-free; the GPU passes use the same
 * kernels, bin slopes and normalisers (uploaded from here), so both backends agree.
 *
 * Public API
 *   EDGE_SIGMA, EDGE_SIGMA_RATIO   DoG scales in analysis px (σ and k·σ)
 *   EDGE_COHERENCE, EDGE_KEEP      dominance share of the winning orientation; §8 hysteresis band
 *   edgeKernels()                  → EdgeKernels: one-sided normalised Gaussian weights (f32 values)
 *   dogPlane(L, w, h)              → Float32Array D = G(σ)∗L − G(kσ)∗L (separable, edges clamped,
 *                                    the horizontal pass stored as f32 like the GPU's target)
 *   edgeSetup(sw, sh, glyphSplit, threshold) → EdgeSetup (bin slopes, strength normalisers, threshold)
 *   edgeStroke(D, w, h, x0, y0, setup, prev, band)  → EdgeStroke index of a cell, or −1 (not an edge);
 *                                    `prev` / `band`: §8 hysteresis (the previous frame's stroke, or −1)
 */
import { EdgeStroke } from './charsets';

/**
 * Scale of the narrow Gaussian, in analysis px (a cell is 8 px wide). Tuned on the fixtures and the
 * corpus: σ = 1 also outlines fine photographic texture (rooftops, foliage) as '-' carpets; 1.5
 * keeps object outlines and line art while ignoring that texture; 2 adds nothing over 1.5 but
 * pushes outlines a cell outwards.
 */
export const EDGE_SIGMA = 1.5;
/** The wide Gaussian is k·σ (1.6 approximates a Laplacian of Gaussian). */
export const EDGE_SIGMA_RATIO = 1.6;
/** The winning orientation must carry at least this share of the cell's gradient energy (texture spreads it). */
export const EDGE_COHERENCE = 0.6;
/** §8: a cell that was this stroke last frame keeps it down to threshold − stability·EDGE_KEEP. */
export const EDGE_KEEP = 0.05;
/** Strength threshold at edgeThreshold = 1; it scales linearly from 0. */
const EDGE_STRENGTH_MAX = 0.6;

export interface EdgeKernels {
  /** Taps reach ±radius px. */
  radius: number;
  /** w[i] for offset ±i, i = 0..radius; the full kernel sums to 1. */
  g1: Float32Array;
  g2: Float32Array;
}

function gaussian(sigma: number, radius: number): Float32Array {
  const w = Float64Array.from({ length: radius + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  let total = w[0];
  for (let i = 1; i <= radius; i++) total += 2 * w[i];
  return Float32Array.from(w, (v) => v / total);
}

let kernels: EdgeKernels | null = null;

export function edgeKernels(): EdgeKernels {
  if (!kernels) {
    const radius = Math.ceil(3 * EDGE_SIGMA * EDGE_SIGMA_RATIO);
    kernels = { radius, g1: gaussian(EDGE_SIGMA, radius), g2: gaussian(EDGE_SIGMA * EDGE_SIGMA_RATIO, radius) };
  }
  return kernels;
}

/** D = G(σ)∗L − G(kσ)∗L over a w × h plane, clamping at the image edge. */
export function dogPlane(L: Float32Array, w: number, h: number): Float32Array {
  const { radius: r, g1, g2 } = edgeKernels();
  const h1 = new Float32Array(w * h);
  const h2 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      for (let i = -r; i <= r; i++) {
        const v = L[row + Math.min(w - 1, Math.max(0, x + i))];
        const k = i < 0 ? -i : i;
        a += g1[k] * v;
        b += g2[k] * v;
      }
      h1[row + x] = a;
      h2[row + x] = b;
    }
  }
  const D = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      for (let j = -r; j <= r; j++) {
        const o = Math.min(h - 1, Math.max(0, y + j)) * w + x;
        const k = j < 0 ? -j : j;
        a += g1[k] * h1[o];
        b += g2[k] * h2[o];
      }
      D[y * w + x] = a - b;
    }
  }
  return D;
}

export interface EdgeSetup {
  sw: number;
  sh: number;
  /**
   * Orientation bins by gradient slope |gy| / |gx|: up to tanSteep a vertical line ('|'), from
   * tanFlat a horizontal one ('-' / '_'), diagonal in between. The boundaries lie halfway (in angle)
   * between the strokes' own directions, and a '/' spans the cell's diagonal, so the cell aspect
   * sets them: in an 8 × 16 cell a '/' rises at 63°, so lines steeper than 77° read '|' and
   * flatter than 32° read '-'.
   */
  tanSteep: number;
  tanFlat: number;
  /** Gradient energy of a unit-contrast edge crossing the cell centre along each bin's stroke. */
  norm: Float32Array;
  /** Fraction of the cell height below which a horizontal edge is '_' (GlyphSet.lowStrokeSplit). */
  lowSplit: number;
  /** Minimum normalised strength (≈ the edge's tone contrast) for a stroke. */
  threshold: number;
}

/** Summed Sobel magnitude across a unit step edge, per pixel of edge length. */
let stepResponse = 0;

function unitStepResponse(): number {
  if (!stepResponse) {
    const w = 64;
    const h = 5;
    const L = Float32Array.from({ length: w * h }, (_, i) => (i % w >= w / 2 ? 1 : 0));
    const D = dogPlane(L, w, h);
    for (let x = 1; x < w - 1; x++) stepResponse += sobelMagnitude(D, w, h, x, 2, null);
  }
  return stepResponse;
}

export function edgeSetup(sw: number, sh: number, lowSplit: number, threshold: number): EdgeSetup {
  const diagonal = Math.atan2(sw, sh); // gradient angle of a '/' spanning the cell diagonal
  const p = unitStepResponse();
  return {
    sw,
    sh,
    tanSteep: Math.tan(diagonal / 2),
    tanFlat: Math.tan((diagonal + Math.PI / 2) / 2),
    norm: Float32Array.from([p * sh, p * Math.hypot(sw, sh), p * Math.hypot(sw, sh), p * sw]),
    lowSplit,
    threshold: EDGE_STRENGTH_MAX * Math.min(1, Math.max(0, threshold)),
  };
}

/** Sobel gradient magnitude of D at (x, y), clamping at the image edge; writes (gx, gy) to g. */
function sobelMagnitude(D: Float32Array, w: number, h: number, x: number, y: number, g: Float64Array | null): number {
  const xm = Math.max(0, x - 1);
  const xp = Math.min(w - 1, x + 1);
  const ym = Math.max(0, y - 1) * w;
  const y0 = y * w;
  const yp = Math.min(h - 1, y + 1) * w;
  const gx = D[ym + xp] + 2 * D[y0 + xp] + D[yp + xp] - (D[ym + xm] + 2 * D[y0 + xm] + D[yp + xm]);
  const gy = D[yp + xm] + 2 * D[yp + x] + D[yp + xp] - (D[ym + xm] + 2 * D[ym + x] + D[ym + xp]);
  if (g) {
    g[0] = gx;
    g[1] = gy;
  }
  return Math.sqrt(gx * gx + gy * gy);
}

const gradient = new Float64Array(2);
const energy = new Float64Array(4);

/**
 * The stroke a cell (top-left analysis pixel x0, y0) becomes, or −1. Each pixel adds its Sobel
 * magnitude to its orientation bin; the strongest bin wins when it holds EDGE_COHERENCE of the
 * total and its strength (energy / norm) reaches the threshold, lowered by `keep` (§8 hysteresis
 * for a cell that showed this stroke last frame: pass the previous stroke and the band).
 */
export function edgeStroke(D: Float32Array, w: number, h: number, x0: number, y0: number, s: EdgeSetup, prev: number, band: number): number {
  energy.fill(0);
  let lowMoment = 0;
  for (let y = 0; y < s.sh; y++) {
    for (let x = 0; x < s.sw; x++) {
      const m = sobelMagnitude(D, w, h, x0 + x, y0 + y, gradient);
      const ax = Math.abs(gradient[0]);
      const ay = Math.abs(gradient[1]);
      let bin: number;
      if (ay <= s.tanSteep * ax) bin = EdgeStroke.vertical;
      else if (ay >= s.tanFlat * ax) bin = EdgeStroke.horizontal;
      else bin = gradient[0] * gradient[1] > 0 ? EdgeStroke.rising : EdgeStroke.falling;
      energy[bin] += m;
      if (bin === EdgeStroke.horizontal) lowMoment += m * (y + 0.5);
    }
  }
  let best = 0;
  for (let b = 1; b < 4; b++) if (energy[b] > energy[best]) best = b;
  const total = energy[0] + energy[1] + energy[2] + energy[3];
  if (!(energy[best] > 0) || energy[best] < EDGE_COHERENCE * total) return -1;
  const stroke = best === EdgeStroke.horizontal && lowMoment / energy[best] > s.lowSplit * s.sh ? EdgeStroke.low : best;
  const need = s.threshold - (stroke === prev ? band : 0);
  return energy[best] / s.norm[best] >= need ? stroke : -1;
}
