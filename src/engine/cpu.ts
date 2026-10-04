/**
 * CPU reference implementation of the analysis pass (docs/ALGORITHM.md §2–§8). DOM-free and
 * deterministic: the same still + params give a byte-identical grid. The GPU renderer is checked
 * against it.
 *
 * Public API
 *   analyzeCpu(image, params, levels, geometry, glyphSet, taps, options?) → CpuResult
 *       image     straight (non-premultiplied) RGBA8, e.g. ImageData
 *       levels    measured auto-levels (ignored when params.autoLevels is false)
 *       taps      buildTapTables(analysisSize(grid, geometry).sw, .sh): the tables the glyph set was built with
 *       options.history  pass one CpuHistory per clip to enable §8 temporal stability (GIF / video only)
 *       options.grid     the grid to produce (default: gridSize of the image), e.g. the grid of the
 *                        full-size source when `image` is a downscaled copy of it
 *   createHistory()                      → CpuHistory (resets itself when mode / grid / glyph set change)
 *   analysisLightness(image, size, tone) → tone-mapped lightness at analysis resolution
 *   sampleCells(L, size, grid, tables)   → per-cell weighted sums for each tap table (circle means)
 *   toSnapshot(result, glyphSet, params, geometry) → GridSnapshot (characters for TXT / SVG / HTML)
 *   cellCharOf(mode, glyphSet)           grid index → character
 *   THRESHOLD_KEEP, FIT_KEEP             §8 hysteresis constants (shared with the GPU)
 *
 * CpuResult.indices per mode: shape / ramp → glyph index into glyphSet.atlasChars (edge strokes
 * included); braille → dot bits (U+2800 + bits); blocks → quadrant bits (QUADRANT_CHARS); halftone →
 * index into HALFTONE_TEXT_RAMP.
 */
import type { CellGeometry, GridSize, GridSnapshot, Levels, RenderParams } from './types';
import type { GlyphSet } from './atlas';
import { AFFECTS, buildRectTaps, type TapTable, type TapTables } from './layout';
import { analysisSize, gridSize, type AnalysisSize } from './geometry';
import { toneConstants, toneMapPlane, type ToneConstants } from './tone';
import { threshold, toneDither, toneNoise } from './dither';
import { parseHexColor } from './color';
import { createQuery, glyphDistance, nearestForQuery, prepareQuery } from './match';
import { resampleLumaAlpha, resampleRgbaPremultiplied } from './resample';
import { dogPlane, EDGE_KEEP, edgeSetup, edgeStroke } from './edges';
import {
  BRAILLE_BITS,
  brailleChar,
  HALFTONE_TEXT_RAMP,
  halftoneTextIndex,
  quadrantChar,
  rampOrder,
} from './charsets';

export interface CpuImage {
  rgba: ArrayLike<number>;
  width: number;
  height: number;
}

export interface CpuResult {
  grid: GridSize;
  indices: Uint16Array;
  /** Per-cell mean tone-mapped lightness (halftone: dot coverage). */
  tone: Float32Array;
  /** Per-cell RGB: mean source colour over the paper (blocks colour mode: the foreground). */
  colors: Uint8Array;
  /** Blocks colour mode only: per-cell background RGB. */
  backgrounds?: Uint8Array;
}

/** §8 state for one clip. Treat as opaque. */
export interface CpuHistory {
  key: string;
  glyphSet: GlyphSet | null;
  /** Filtered feature vector per cell (shape: 6 circles, ramp / halftone: 1, braille: 8, blocks: 4). */
  vec: Float32Array;
  /** Previous glyph per cell (shape / ramp: glyph index, braille / blocks: bits), −1 when none. */
  glyph: Int32Array;
  valid: Uint8Array;
}

export function createHistory(): CpuHistory {
  return { key: '', glyphSet: null, vec: new Float32Array(0), glyph: new Int32Array(0), valid: new Uint8Array(0) };
}

const FEATURES: Record<RenderParams['mode'], number> = { shape: 6, ramp: 1, braille: 8, blocks: 4, halftone: 1 };

function prepareHistory(h: CpuHistory, params: RenderParams, grid: GridSize, glyphSet: GlyphSet): void {
  const key = `${params.mode}|${grid.cols}x${grid.rows}`;
  if (h.key === key && h.glyphSet === glyphSet) return;
  const cells = grid.cols * grid.rows;
  h.key = key;
  h.glyphSet = glyphSet;
  h.vec = new Float32Array(cells * FEATURES[params.mode]);
  h.glyph = new Int32Array(cells).fill(-1);
  h.valid = new Uint8Array(cells);
}

/**
 * §8 hysteresis for thresholded features (braille dots, block quadrants): a dot that was on stays on
 * down to threshold − stability·THRESHOLD_KEEP, one that was off needs threshold + the same.
 */
export const THRESHOLD_KEEP = 0.05;

/**
 * The threshold shift for a dot that was on (side −1) or off (side +1). Near the ends the band
 * shrinks to half the distance to 0 or 1, so a shifted threshold stays strictly inside (0, 1):
 * pure white and black dots are decided by the image alone, whatever the previous frame showed.
 */
function hysteresis(threshold: number, band: number, side: number): number {
  return side * Math.min(band, threshold / 2, (1 - threshold) / 2);
}
/** §8 for the blocks colour fit: the previous partition is kept while its error is within stability·FIT_KEEP of the best. */
export const FIT_KEEP = 4 * THRESHOLD_KEEP * THRESHOLD_KEEP;

/** §8: exponential smoothing that lets big changes (cuts, fast motion) through immediately. */
function smooth(h: CpuHistory, cell: number, v: Float64Array, n: number, stability: number): void {
  const base = cell * n;
  if (!h.valid[cell]) {
    for (let k = 0; k < n; k++) h.vec[base + k] = v[k];
    h.valid[cell] = 1;
    return;
  }
  let delta = 0;
  for (let k = 0; k < n; k++) delta = Math.max(delta, Math.abs(v[k] - h.vec[base + k]));
  const alpha = Math.max(1 - 0.7 * stability, Math.min(1, delta * 4));
  for (let k = 0; k < n; k++) {
    const f = h.vec[base + k] + (v[k] - h.vec[base + k]) * alpha;
    h.vec[base + k] = f;
    v[k] = f;
  }
}

/** Tone-mapped lightness (§3) of the source area-resampled to the analysis resolution. */
export function analysisLightness(image: CpuImage, size: AnalysisSize, tone: ToneConstants): Float32Array {
  const la = resampleLumaAlpha(image.rgba, image.width, image.height, size.width, size.height);
  return toneMapPlane(la, new Float32Array(size.width * size.height), tone);
}

/**
 * Weighted sums of L over each tap table at every cell: out[cell·n + t] for table t. External taps
 * clamp to the image edge; cells whose taps all fall inside the image take an unclamped fast path.
 */
export function sampleCells(L: Float32Array, size: AnalysisSize, grid: GridSize, tables: readonly TapTable[]): Float64Array {
  const { sw, sh, width: aw, height: ah } = size;
  const n = tables.length;
  const out = new Float64Array(grid.cols * grid.rows * n);
  const offsets = tables.map((t) => Int32Array.from(t.dx, (dx, i) => t.dy[i] * aw + dx));
  let rx0 = 0;
  let rx1 = 0;
  let ry0 = 0;
  let ry1 = 0;
  for (const t of tables) {
    for (let i = 0; i < t.w.length; i++) {
      rx0 = Math.min(rx0, t.dx[i]);
      rx1 = Math.max(rx1, t.dx[i]);
      ry0 = Math.min(ry0, t.dy[i]);
      ry1 = Math.max(ry1, t.dy[i]);
    }
  }
  for (let row = 0; row < grid.rows; row++) {
    const y0 = row * sh;
    const insideY = y0 + ry0 >= 0 && y0 + ry1 < ah;
    for (let col = 0; col < grid.cols; col++) {
      const x0 = col * sw;
      const inside = insideY && x0 + rx0 >= 0 && x0 + rx1 < aw;
      const o = (row * grid.cols + col) * n;
      for (let t = 0; t < n; t++) {
        const { dx, dy, w } = tables[t];
        let s = 0;
        if (inside) {
          const base = y0 * aw + x0;
          const off = offsets[t];
          for (let i = 0; i < w.length; i++) s += w[i] * L[base + off[i]];
        } else {
          for (let i = 0; i < w.length; i++) {
            const x = Math.min(aw - 1, Math.max(0, x0 + dx[i]));
            const y = Math.min(ah - 1, Math.max(0, y0 + dy[i]));
            s += w[i] * L[y * aw + x];
          }
        }
        out[o + t] = s;
      }
    }
  }
  return out;
}

interface Ramp {
  /** glyphSet.rampGlyphs sorted by mean coverage (ties by index). */
  order: Uint16Array;
  sorted: Float32Array;
  /** 1 for a ramp candidate, by glyph index. */
  member: Uint8Array;
}

const ramps = new WeakMap<GlyphSet, Ramp>();

function rampFor(glyphSet: GlyphSet): Ramp {
  let r = ramps.get(glyphSet);
  if (!r) {
    const member = new Uint8Array(glyphSet.chars.length);
    for (const g of glyphSet.rampGlyphs) member[g] = 1;
    const order = rampOrder(glyphSet.meanCoverage).filter((g) => member[g] === 1);
    r = { order, sorted: Float32Array.from(order, (g) => glyphSet.meanCoverage[g]), member };
    ramps.set(glyphSet, r);
  }
  return r;
}

/** Glyph whose mean coverage is nearest t; ties go to the lowest glyph index. */
function nearestCoverage(ramp: Ramp, t: number): number {
  const { order, sorted } = ramp;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first entry ≥ t (and the lowest index of its run); compare with the run just below.
  let below = lo - 1;
  while (below > 0 && sorted[below - 1] === sorted[below]) below--;
  if (lo >= sorted.length) return order[below];
  if (below < 0) return order[lo];
  const dBelow = t - sorted[below];
  const dAbove = sorted[lo] - t;
  if (dBelow < dAbove) return order[below];
  if (dAbove < dBelow) return order[lo];
  return Math.min(order[below], order[lo]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** §5 global then directional contrast, in place on the six internal means. */
function sharpen(q: Float64Array, e: Float64Array, global: number, directional: number): void {
  if (global !== 1) {
    let m = 0;
    for (let k = 0; k < 6; k++) m = Math.max(m, q[k]);
    if (m > 0) for (let k = 0; k < 6; k++) q[k] = Math.pow(q[k] / m, global) * m;
  }
  if (directional !== 1) {
    for (let k = 0; k < 6; k++) {
      let m = q[k];
      for (const j of AFFECTS[k]) m = Math.max(m, e[j]);
      if (m > 0) q[k] = Math.pow(q[k] / m, directional) * m;
    }
  }
}

/** Mean colour of the quadrants whose bit in `mask` equals `want`; returns how many there are. */
function groupMean(quad: Float64Array, mask: number, want: number, dst: Float64Array): number {
  dst.fill(0);
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (((mask >> i) & 1) !== want) continue;
    n++;
    for (let c = 0; c < 3; c++) dst[c] += quad[i * 3 + c];
  }
  if (n > 0) for (let c = 0; c < 3; c++) dst[c] /= n;
  return n;
}

function groupError(quad: Float64Array, mask: number, want: number, mean: Float64Array): number {
  if (groupMean(quad, mask, want, mean) === 0) return 0;
  let e = 0;
  for (let i = 0; i < 4; i++) {
    if (((mask >> i) & 1) !== want) continue;
    for (let c = 0; c < 3; c++) e += (quad[i * 3 + c] - mean[c]) ** 2;
  }
  return e;
}

interface TwoColourFit {
  bits: number;
  fg: Float64Array;
  bg: Float64Array;
}

/**
 * Errors / tones closer than these are ties (→ lowest mask, no flip), as on the GPU (shaders.ts
 * FIT_EPS / TONE_EPS): in a flat area the partitions differ only by rounding noise, which must not
 * decide the cell.
 */
const FIT_EPS = 1e-9;
const TONE_EPS = 1e-6;

/**
 * Blocks colour mode (§6): the 2-colour partition of the four quadrant colours with least squared
 * error. Complementary partitions tie, so only masks 0..7 are tried (0 = a single colour). The
 * 'on' side is the inkier one so the text form matches the mono mode.
 *
 * §8: given the previous frame's bits (`prev`, −1 for none), its partition is kept while its error
 * is within `fitBand` of the best (unless the best is a single colour), and its orientation (which
 * side is on, or the single colour's █ / space) while the deciding tones differ by less than
 * `toneBand`.
 */
function fitTwoColours(quad: Float64Array, tone: Float64Array, out: TwoColourFit, prev: number, fitBand: number, toneBand: number): void {
  const partitionError = (m: number) => groupError(quad, m, 1, out.fg) + groupError(quad, m, 0, out.bg);
  let bestMask = 0;
  let bestErr = Infinity;
  for (let m = 0; m < 8; m++) {
    const err = partitionError(m);
    if (err < bestErr - FIT_EPS) {
      bestErr = err;
      bestMask = m;
    }
  }
  // A flat cell (the single colour fits best) is never split by history: the split would be invisible
  // (both sides the same colour) but change the cell's character.
  const prevMask = prev < 0 ? -1 : prev < 8 ? prev : 15 - prev;
  if (bestMask !== 0 && prevMask >= 0 && prevMask !== bestMask && partitionError(prevMask) <= bestErr + fitBand) bestMask = prevMask;
  let onT = 0;
  let offT = 0;
  let onN = 0;
  for (let i = 0; i < 4; i++) {
    if ((bestMask >> i) & 1) {
      onT += tone[i];
      onN++;
    } else offT += tone[i];
  }
  if (bestMask === 0) {
    const margin = prev === 15 ? -toneBand : prev === 0 ? toneBand : 0;
    out.bits = offT / 4 > 0.5 + margin ? 15 : 0;
  } else {
    const margin = prev === bestMask ? toneBand : prev === 15 - bestMask ? -toneBand : 0;
    out.bits = onT / onN - offT / (4 - onN) < -TONE_EPS - margin ? 15 - bestMask : bestMask;
  }
  const hasFg = groupMean(quad, out.bits, 1, out.fg) > 0;
  const hasBg = groupMean(quad, out.bits, 0, out.bg) > 0;
  if (!hasFg) out.fg.set(out.bg);
  if (!hasBg) out.bg.set(out.fg);
}

const subTaps = new Map<string, TapTable[]>();

function rectTaps(sw: number, sh: number, nx: number, ny: number): TapTable[] {
  const key = `${sw}x${sh}/${nx}x${ny}`;
  let t = subTaps.get(key);
  if (!t) {
    t = buildRectTaps(sw, sh, nx, ny);
    subTaps.set(key, t);
  }
  return t;
}

export interface AnalyzeOptions {
  /** One per clip enables §8 temporal stability (GIF / video only). */
  history?: CpuHistory;
  /** The grid to produce; default gridSize of the image. */
  grid?: GridSize;
}

export function analyzeCpu(
  image: CpuImage,
  params: RenderParams,
  levels: Levels,
  geometry: CellGeometry,
  glyphSet: GlyphSet,
  taps: TapTables,
  options: AnalyzeOptions = {},
): CpuResult {
  const { history } = options;
  const grid = options.grid ?? gridSize(image.width, image.height, params.columns, geometry);
  const size = analysisSize(grid, geometry);
  if (size.sw !== taps.sw || size.sh !== taps.sh) {
    throw new Error(`Tap tables are for ${taps.sw}×${taps.sh} sub-cells but the geometry needs ${size.sw}×${size.sh}`);
  }
  const { cols, rows } = grid;
  const { sw, sh, width: aw, height: ah } = size;
  const cells = cols * rows;
  const L = analysisLightness(image, size, toneConstants(params, levels));

  // Cell means of the tone-mapped lightness: every mode's tone output and ramp / halftone input.
  const tone = new Float32Array(cells);
  {
    const sums = new Float64Array(cells);
    for (let y = 0; y < ah; y++) {
      const rowBase = ((y / sh) | 0) * cols;
      for (let x = 0; x < aw; x++) sums[rowBase + ((x / sw) | 0)] += L[y * aw + x];
    }
    const inv = 1 / (sw * sh);
    for (let i = 0; i < cells; i++) tone[i] = sums[i] * inv;
  }

  if (history) prepareHistory(history, params, grid, glyphSet);
  const stability = params.stability;
  const indices = new Uint16Array(cells);
  const blocksColour = params.mode === 'blocks' && params.colorMode === 'source';

  // Colours on a 2× grid: quadrant colours for blocks, averaged to the cell colour for every mode.
  const paper = parseHexColor(params.paper).map((v) => v / 255);
  const quadColours = resampleRgbaPremultiplied(image.rgba, image.width, image.height, cols * 2, rows * 2);
  for (let i = 0; i < quadColours.length; i += 4) {
    const a = quadColours[i + 3];
    for (let c = 0; c < 3; c++) quadColours[i + c] += (1 - a) * paper[c];
  }
  const colors = new Uint8Array(cells * 3);
  const backgrounds = blocksColour ? new Uint8Array(cells * 3) : undefined;
  const quad = new Float64Array(12);
  const quadOf = (col: number, row: number) => {
    for (let i = 0; i < 4; i++) {
      const o = ((row * 2 + (i >> 1)) * cols * 2 + col * 2 + (i & 1)) * 4;
      for (let c = 0; c < 3; c++) quad[i * 3 + c] = quadColours[o + c];
    }
  };
  const to8 = (v: number) => Math.round(clamp01(v) * 255);

  const feat = new Float64Array(8);
  const ext = new Float64Array(10);
  /** The previous frame's glyph / bits of a cell, −1 without history. */
  const prevOf = (cell: number) => (history ? history.glyph[cell] : -1);

  // §5b edge layer (shape and ramp): stroke glyphs override the fill where the image has an edge.
  const edges = params.edges && (params.mode === 'shape' || params.mode === 'ramp');
  const D = edges ? dogPlane(L, aw, ah) : null;
  const edgeConfig = edges ? edgeSetup(sw, sh, glyphSet.lowStrokeSplit, params.edgeThreshold) : null;
  const edgeBand = history ? stability * EDGE_KEEP : 0;
  const withEdge = (cell: number, col: number, row: number, fill: number): number => {
    if (!D || !edgeConfig) return fill;
    const prev = prevOf(cell);
    const prevStroke = prev >= 0 ? glyphSet.strokes.indexOf(prev) : -1;
    const stroke = edgeStroke(D, aw, ah, col * sw, row * sh, edgeConfig, prevStroke, edgeBand);
    return stroke >= 0 ? glyphSet.strokes[stroke] : fill;
  };

  if (params.mode === 'shape') {
    const tables = [...taps.internal, ...taps.external];
    const circles = sampleCells(L, size, grid, tables);
    const stride = tables.length;
    const W = glyphSet.anchor;
    const matchable = glyphSet.chars.length;
    const q = new Float64Array(6);
    const query = createQuery();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = row * cols + col;
        for (let k = 0; k < 6; k++) feat[k] = circles[cell * stride + k];
        for (let j = 0; j < 10; j++) ext[j] = circles[cell * stride + 6 + j];
        sharpen(feat, ext, params.shapeSharpness, params.edgeSharpness);
        const noise = toneNoise(col, row);
        for (let k = 0; k < 6; k++) feat[k] = toneDither(feat[k], noise, params.dither);
        if (history) smooth(history, cell, feat, 6, stability);
        for (let k = 0; k < 6; k++) q[k] = feat[k] * W;
        prepareQuery(q, query);
        let best = nearestForQuery(query, glyphSet);
        const prev = prevOf(cell);
        // Keep the previous glyph while it is nearly as good (an edge stroke outside the charset is not matchable).
        if (prev >= 0 && prev < matchable && prev !== best) {
          if (glyphDistance(query, glyphSet, best) >= glyphDistance(query, glyphSet, prev) - stability * 0.02) best = prev;
        }
        best = withEdge(cell, col, row, best);
        if (history) history.glyph[cell] = best;
        indices[cell] = best;
      }
    }
  } else if (params.mode === 'ramp') {
    const ramp = rampFor(glyphSet);
    const W = glyphSet.rampAnchor;
    const cov = glyphSet.meanCoverage;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = row * cols + col;
        feat[0] = toneDither(tone[cell], toneNoise(col, row), params.dither);
        if (history) smooth(history, cell, feat, 1, stability);
        const t = feat[0] * W;
        let best = nearestCoverage(ramp, t);
        const prev = prevOf(cell);
        if (prev >= 0 && prev < cov.length && ramp.member[prev] === 1 && prev !== best) {
          if (Math.abs(t - cov[best]) >= Math.abs(t - cov[prev]) - stability * 0.02) best = prev;
        }
        best = withEdge(cell, col, row, best);
        if (history) history.glyph[cell] = best;
        indices[cell] = best;
      }
    }
  } else if (params.mode === 'braille' || params.mode === 'blocks') {
    const braille = params.mode === 'braille';
    const nx = 2;
    const ny = braille ? 4 : 2;
    const n = nx * ny;
    const dots = sampleCells(L, size, grid, rectTaps(sw, sh, nx, ny));
    const fit: TwoColourFit = { bits: 0, fg: new Float64Array(3), bg: new Float64Array(3) };
    const band = history ? stability * THRESHOLD_KEEP : 0;
    const fitBand = history ? stability * FIT_KEEP : 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = row * cols + col;
        for (let i = 0; i < n; i++) feat[i] = dots[cell * n + i];
        if (history) smooth(history, cell, feat, n, stability);
        const prev = prevOf(cell);
        let bits = 0;
        if (blocksColour) {
          quadOf(col, row);
          fitTwoColours(quad, feat, fit, prev, fitBand, band);
          bits = fit.bits;
          const o = cell * 3;
          for (let c = 0; c < 3; c++) {
            colors[o + c] = to8(fit.fg[c]);
            backgrounds![o + c] = to8(fit.bg[c]);
          }
        } else {
          for (let i = 0; i < n; i++) {
            const dx = i % nx;
            const dy = (i / nx) | 0;
            const bit = braille ? BRAILLE_BITS[dy][dx] : 1 << i;
            const t = threshold(params.ditherPattern, col * nx + dx, row * ny + dy);
            if (feat[i] > t + hysteresis(t, band, prev < 0 ? 0 : prev & bit ? -1 : 1)) bits |= bit;
          }
        }
        if (history) history.glyph[cell] = bits;
        indices[cell] = bits;
      }
    }
  } else {
    for (let cell = 0; cell < cells; cell++) {
      feat[0] = tone[cell];
      if (history) smooth(history, cell, feat, 1, stability);
      tone[cell] = feat[0];
      indices[cell] = halftoneTextIndex(feat[0]);
    }
  }

  if (!blocksColour) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        quadOf(col, row);
        const o = (row * cols + col) * 3;
        for (let c = 0; c < 3; c++) colors[o + c] = to8((quad[c] + quad[3 + c] + quad[6 + c] + quad[9 + c]) / 4);
      }
    }
  }
  return backgrounds ? { grid, indices, tone, colors, backgrounds } : { grid, indices, tone, colors };
}

/** Maps a grid index (CpuResult.indices) of `mode` to its character. */
export function cellCharOf(mode: RenderParams['mode'], glyphSet: GlyphSet): (index: number) => string {
  if (mode === 'braille') return brailleChar;
  if (mode === 'blocks') return quadrantChar;
  if (mode === 'halftone') return (i) => HALFTONE_TEXT_RAMP[i];
  return (i) => glyphSet.atlasChars[i];
}

export function toSnapshot(result: CpuResult, glyphSet: GlyphSet, params: RenderParams, geometry: CellGeometry): GridSnapshot {
  const snapshot: GridSnapshot = {
    cols: result.grid.cols,
    rows: result.grid.rows,
    chars: Array.from(result.indices, cellCharOf(params.mode, glyphSet)),
    colors: result.colors,
    tone: result.tone,
    geometry,
    params,
  };
  if (result.backgrounds) snapshot.backgrounds = result.backgrounds;
  return snapshot;
}
