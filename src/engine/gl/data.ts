/**
 * Uniform-block data for the cell shaders (DOM-free).
 *
 * Public API
 *   packGlyphs(glyphSet)   → Float32Array for the `Glyphs` block (std140): 2 vec4 per glyph,
 *                            (μ, ρ0, ρ1, ρ2), (ρ3, ρ4, ρ5, ramp), padded to MAX_GLYPHS; ramp is 1
 *                            for ramp mode's candidates (GlyphSet.rampGlyphs), else 0
 *   packTaps(taps)         → ArrayBuffer for the `Taps` block (std140): MAX_TAP_TABLES ivec4
 *                            (first tap, count, 0, 0), then MAX_TAPS vec4 (dx, dy, w, 0); tables in
 *                            the shaders' order: 6 internal and 10 external circles, 8 braille dots,
 *                            4 block quadrants
 */
import type { GlyphSet } from '../atlas';
import { MAX_GLYPHS } from '../charsets';
import { glyphResiduals } from '../match';
import { buildRectTaps, packTapTables, type TapTables } from '../layout';
import { MAX_TAP_TABLES, MAX_TAPS } from './shaders';

/** μ_g (mean normalised coverage) and ρ_g (the vector minus its mean) for docs/ALGORITHM.md §5. */
export function packGlyphs(glyphSet: GlyphSet): Float32Array<ArrayBuffer> {
  const n = glyphSet.chars.length;
  if (n > MAX_GLYPHS) throw new Error(`At most ${MAX_GLYPHS} glyphs fit the GPU matcher (got ${n}).`);
  const residuals = glyphResiduals(glyphSet);
  const out = new Float32Array(MAX_GLYPHS * 8);
  for (let g = 0; g < n; g++) {
    out[g * 8] = glyphSet.meanCoverage[g];
    for (let k = 0; k < 6; k++) out[g * 8 + 1 + k] = residuals[g * 6 + k];
  }
  for (const g of glyphSet.rampGlyphs) out[g * 8 + 7] = 1;
  return out;
}

/** The §2 circles and the §6 braille / block rectangles of one sub-cell size, as the shaders read them. */
export function packTaps(taps: TapTables): ArrayBuffer {
  const tables = [...taps.internal, ...taps.external, ...buildRectTaps(taps.sw, taps.sh, 2, 4), ...buildRectTaps(taps.sw, taps.sh, 2, 2)];
  const packed = packTapTables(tables);
  const count = packed.taps.length / 3;
  if (tables.length > MAX_TAP_TABLES || count > MAX_TAPS) {
    throw new Error(`The ${taps.sw}×${taps.sh} sub-cell needs ${count} taps; the GPU tap block holds ${MAX_TAPS}.`);
  }
  const buffer = new ArrayBuffer((MAX_TAP_TABLES + MAX_TAPS) * 16);
  const ranges = new Int32Array(buffer, 0, MAX_TAP_TABLES * 4);
  tables.forEach((_, i) => {
    ranges[i * 4] = packed.offsets[i];
    ranges[i * 4 + 1] = packed.counts[i];
  });
  const list = new Float32Array(buffer, MAX_TAP_TABLES * 16, MAX_TAPS * 4);
  for (let t = 0; t < count; t++) list.set(packed.taps.subarray(t * 3, t * 3 + 3), t * 4);
  return buffer;
}
