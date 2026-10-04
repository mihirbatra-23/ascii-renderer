/**
 * Sampling layout (docs/ALGORITHM.md §2): the shape-vector circles and their exact area-weighted
 * tap tables, shared by the image analysis and the glyph vectors so both are sampled identically.
 *
 * Public API
 *   SW                         analysis pixels per cell horizontally (8)
 *   INTERNAL_CIRCLES           6 circles inside the cell (I0..I5)
 *   EXTERNAL_CIRCLES           10 circles reaching into neighbouring cells (E0..E9)
 *   AFFECTS                    for each internal circle, the externals that sharpen it (§5)
 *   buildTapTables(sw, sh)     → TapTables (6 internal + 10 external tap lists)
 *   buildRectTaps(sw, sh, nx, ny) → nx·ny area-weighted sub-rectangles (braille dots, block quadrants)
 *   packTapTables(tables)      → flat Float32Array form for GPU upload
 */

export const SW = 8;

/** Circle in cell-normalised units: x in cell widths, y in cell heights, r in cell widths. */
export interface Circle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

const RI = 0.3;
const RE = 0.25;

export const INTERNAL_CIRCLES: readonly Circle[] = [
  { x: 0.29, y: 0.21, r: RI },
  { x: 0.71, y: 0.16, r: RI },
  { x: 0.29, y: 0.52, r: RI },
  { x: 0.71, y: 0.48, r: RI },
  { x: 0.29, y: 0.84, r: RI },
  { x: 0.71, y: 0.79, r: RI },
];

export const EXTERNAL_CIRCLES: readonly Circle[] = [
  { x: 0.29, y: -0.15, r: RE },
  { x: 0.71, y: -0.15, r: RE },
  { x: -0.3, y: 0.21, r: RE },
  { x: 1.3, y: 0.16, r: RE },
  { x: -0.3, y: 0.52, r: RE },
  { x: 1.3, y: 0.48, r: RE },
  { x: -0.3, y: 0.84, r: RE },
  { x: 1.3, y: 0.79, r: RE },
  { x: 0.29, y: 1.15, r: RE },
  { x: 0.71, y: 1.15, r: RE },
];

export const AFFECTS: readonly (readonly number[])[] = [
  [0, 1, 2],
  [0, 1, 3],
  [4],
  [5],
  [8, 9, 6],
  [8, 9, 7],
];

/** Taps relative to the cell's top-left analysis pixel; weights sum to 1. */
export interface TapTable {
  readonly dx: Int16Array;
  readonly dy: Int16Array;
  readonly w: Float64Array;
}

export interface TapTables {
  readonly sw: number;
  readonly sh: number;
  readonly internal: readonly TapTable[];
  readonly external: readonly TapTable[];
}

const SUPERSAMPLE = 8;

/**
 * Area of each analysis pixel inside the circle, by 8×8 supersampling. A circle in the right half
 * is computed as its 180° partner (in hundredths, so 1 − 0.71 is exactly 0.29) and its taps are
 * mirrored back: the tables are exactly symmetric, not just up to float rounding.
 */
function circleTaps(c: Circle, sw: number, sh: number, clipToCell: boolean): TapTable {
  const mirrored = c.x > 0.5 || (c.x === 0.5 && c.y > 0.5);
  const xh = Math.round(c.x * 100);
  const yh = Math.round(c.y * 100);
  const cx = ((mirrored ? 100 - xh : xh) * sw) / 100;
  const cy = ((mirrored ? 100 - yh : yh) * sh) / 100;
  const r = c.r * sw;
  const r2 = r * r;
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  const dx: number[] = [];
  const dy: number[] = [];
  const w: number[] = [];
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      let inside = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const oy = py + (sy + 0.5) / SUPERSAMPLE - cy;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const ox = px + (sx + 0.5) / SUPERSAMPLE - cx;
          if (ox * ox + oy * oy <= r2) inside++;
        }
      }
      if (inside === 0) continue;
      const tx = mirrored ? sw - 1 - px : px;
      const ty = mirrored ? sh - 1 - py : py;
      if (clipToCell && (tx < 0 || tx >= sw || ty < 0 || ty >= sh)) continue;
      dx.push(tx);
      dy.push(ty);
      w.push(inside);
    }
  }
  const total = w.reduce((a, b) => a + b, 0);
  return { dx: Int16Array.from(dx), dy: Int16Array.from(dy), w: Float64Array.from(w, (v) => v / total) };
}

export function buildTapTables(sw: number, sh: number): TapTables {
  return {
    sw,
    sh,
    internal: INTERNAL_CIRCLES.map((c) => circleTaps(c, sw, sh, true)),
    external: EXTERNAL_CIRCLES.map((c) => circleTaps(c, sw, sh, false)),
  };
}

/**
 * Split the cell into nx × ny equal rectangles (row-major) with exact fractional pixel weights,
 * so sub-cells stay equal in area even when SH is not divisible by ny.
 */
export function buildRectTaps(sw: number, sh: number, nx: number, ny: number): TapTable[] {
  const overlap = (a0: number, a1: number, p: number) => Math.max(0, Math.min(a1, p + 1) - Math.max(a0, p));
  const tables: TapTable[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const xa = (i * sw) / nx;
      const xb = ((i + 1) * sw) / nx;
      const ya = (j * sh) / ny;
      const yb = ((j + 1) * sh) / ny;
      const dx: number[] = [];
      const dy: number[] = [];
      const w: number[] = [];
      for (let py = Math.floor(ya); py < Math.ceil(yb); py++) {
        for (let px = Math.floor(xa); px < Math.ceil(xb); px++) {
          const a = overlap(xa, xb, px) * overlap(ya, yb, py);
          if (a <= 0) continue;
          dx.push(px);
          dy.push(py);
          w.push(a);
        }
      }
      const total = w.reduce((s, v) => s + v, 0);
      tables.push({ dx: Int16Array.from(dx), dy: Int16Array.from(dy), w: Float64Array.from(w, (v) => v / total) });
    }
  }
  return tables;
}

export interface PackedTaps {
  /** (dx, dy, w) triples for every tap of every table, concatenated in table order. */
  readonly taps: Float32Array;
  /** First tap index of table i. */
  readonly offsets: Int32Array;
  /** Number of taps in table i. */
  readonly counts: Int32Array;
}

/** Flatten tap tables (e.g. [...internal, ...external]) for upload as a GPU texture / uniform buffer. */
export function packTapTables(tables: readonly TapTable[]): PackedTaps {
  const counts = Int32Array.from(tables, (t) => t.w.length);
  const offsets = new Int32Array(tables.length);
  let n = 0;
  tables.forEach((t, i) => {
    offsets[i] = n;
    n += t.w.length;
  });
  const taps = new Float32Array(n * 3);
  tables.forEach((t, i) => {
    for (let k = 0; k < t.w.length; k++) {
      const o = (offsets[i] + k) * 3;
      taps[o] = t.dx[k];
      taps[o + 1] = t.dy[k];
      taps[o + 2] = t.w[k];
    }
  });
  return { taps, offsets, counts };
}
