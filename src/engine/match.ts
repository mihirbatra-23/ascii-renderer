/**
 * Shape matching (docs/ALGORITHM.md §5): exact brute-force nearest glyph under the
 * structure-weighted distance
 *
 *   m = mean(q'),  r = q' − m,  s = clamp(|r| / SHAPE_TAU, SHAPE_MIN, 1)
 *   d(g) = 6·(m − μ_g)² + s·|r − ρ_g|²        μ_g = mean(ĝ_g),  ρ_g = ĝ_g − μ_g
 *
 * At s = 1 this is exactly the plain squared distance |q' − ĝ|²; flat cells (small |r|) weigh
 * tone over shape so smooth areas are not posterised onto a handful of "uniform" glyphs.
 *
 * Public API
 *   SHAPE_TAU, SHAPE_MIN
 *   createQuery() / prepareQuery(q, out)  split an anchored vector q' into tone, shape and weight
 *   nearestForQuery(query, glyphSet)  argmin_g d(g), ties → lowest index
 *   glyphDistance(query, glyphSet, g) d(g) (for §8's keep-the-previous-glyph rule)
 *   nearestGlyph(q, glyphSet)         prepareQuery + nearestForQuery in one call
 *   glyphResiduals(glyphSet)          ρ_g as n × 6 Float32Array (cached; for GPU upload; μ_g is glyphSet.meanCoverage)
 */
import type { GlyphSet } from './atlas';

/** Residual norm at which a cell counts as fully structured (pure shape matching). */
export const SHAPE_TAU = 0.3;
/** Shape weight of a perfectly flat cell. */
export const SHAPE_MIN = 0.2;

export interface MatchQuery {
  /** Tone: mean of the anchored vector. */
  m: number;
  /** Shape: the anchored vector minus its mean. */
  r: Float64Array;
  /** Shape weight s. */
  s: number;
}

export function createQuery(): MatchQuery {
  return { m: 0, r: new Float64Array(6), s: 1 };
}

export function prepareQuery(q: ArrayLike<number>, out: MatchQuery): MatchQuery {
  const m = (q[0] + q[1] + q[2] + q[3] + q[4] + q[5]) / 6;
  let norm2 = 0;
  for (let k = 0; k < 6; k++) {
    const r = q[k] - m;
    out.r[k] = r;
    norm2 += r * r;
  }
  out.m = m;
  out.s = Math.min(1, Math.max(SHAPE_MIN, Math.sqrt(norm2) / SHAPE_TAU));
  return out;
}

const residualCache = new WeakMap<GlyphSet, Float32Array>();

export function glyphResiduals(glyphSet: GlyphSet): Float32Array {
  let res = residualCache.get(glyphSet);
  if (!res) {
    const { vectors, meanCoverage } = glyphSet;
    res = Float32Array.from(vectors, (v, i) => v - meanCoverage[(i / 6) | 0]);
    residualCache.set(glyphSet, res);
  }
  return res;
}

export function glyphDistance(query: MatchQuery, glyphSet: GlyphSet, g: number): number {
  const res = glyphResiduals(glyphSet);
  const t = query.m - glyphSet.meanCoverage[g];
  let shape = 0;
  for (let k = 0; k < 6; k++) {
    const e = query.r[k] - res[g * 6 + k];
    shape += e * e;
  }
  return 6 * t * t + query.s * shape;
}

const scratch = createQuery();

/** `q` is the anchored image vector q·W (or any vector in normalised glyph space). */
export function nearestGlyph(q: ArrayLike<number>, glyphSet: GlyphSet): number {
  return nearestForQuery(prepareQuery(q, scratch), glyphSet);
}

export function nearestForQuery(query: MatchQuery, glyphSet: GlyphSet): number {
  const res = glyphResiduals(glyphSet);
  const mu = glyphSet.meanCoverage;
  const { m, s, r } = query;
  const r0 = r[0];
  const r1 = r[1];
  const r2 = r[2];
  const r3 = r[3];
  const r4 = r[4];
  const r5 = r[5];
  let best = 0;
  let bestD = Infinity;
  for (let g = 0, o = 0; g < mu.length; g++, o += 6) {
    const t = m - mu[g];
    let d = 6 * t * t;
    if (d >= bestD) continue;
    const a = r0 - res[o];
    const b = r1 - res[o + 1];
    const c = r2 - res[o + 2];
    const e = r3 - res[o + 3];
    const f = r4 - res[o + 4];
    const h = r5 - res[o + 5];
    d += s * (a * a + b * b + c * c + e * e + f * f + h * h);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
