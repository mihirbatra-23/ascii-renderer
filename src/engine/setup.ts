/**
 * One call from params to everything the analysis needs (cell geometry, tap tables, glyph set).
 * DOM-free: the caller supplies the canvas factory and must have loaded the font first
 * (fonts.ts `loadFont` in the browser, GlobalFonts.registerFromPath in Node).
 *
 * Public API
 *   prepareAnalysis(params, family, factory) → AnalysisSetup
 */
import type { CellGeometry, RenderParams } from './types';
import { buildGlyphSet, type CanvasFactory, type GlyphSet } from './atlas';
import { analysisSize, computeGeometry, measureFontMetrics } from './geometry';
import { buildTapTables, type TapTables } from './layout';
import { rampCharset, resolveCharset } from './charsets';

export interface AnalysisSetup {
  geometry: CellGeometry;
  taps: TapTables;
  glyphSet: GlyphSet;
}

/** `family` is the CSS font-family of params.font, e.g. FONTS[params.font].family. */
export function prepareAnalysis(
  params: Pick<RenderParams, 'lineHeight' | 'charsetPreset' | 'customCharset'>,
  family: string,
  factory: CanvasFactory,
): AnalysisSetup {
  const metrics = measureFontMetrics(factory(1, 1).ctx, family);
  const geometry = computeGeometry(metrics, { lineHeight: params.lineHeight, family });
  // The sub-grid depends only on the cell, so any grid gives the same SW × SH.
  const { sw, sh } = analysisSize({ cols: 1, rows: 1 }, geometry);
  const taps = buildTapTables(sw, sh);
  return { geometry, taps, glyphSet: buildGlyphSet(resolveCharset(params), geometry, factory, taps, rampCharset(params)) };
}
