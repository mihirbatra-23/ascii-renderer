/**
 * Glyph data for one (font, charset, line height), built in the browser so the vectors come from
 * the same rasteriser that draws the atlas (Node and Chrome rasterise text differently).
 *
 * Public API
 *   GlyphState                   { key, setup (geometry, taps, glyph set), pad }
 *   buildGlyphState(params)      → GlyphState; the font must be loaded (fonts.ts loadFont)
 */
import type { RenderParams } from '../types';
import { FONTS } from '../fonts';
import { browserCanvasFactory } from '../canvas';
import { prepareAnalysis, type AnalysisSetup } from '../setup';
import { glyphKey } from './params';
import { measureInkPadding, type InkPadding } from './glyphAtlas';

export interface GlyphState {
  key: string;
  setup: AnalysisSetup;
  /** How far glyph ink can leave its cell (output px); sizes the atlas tiles. */
  pad: InkPadding;
}

export function buildGlyphState(params: RenderParams): GlyphState {
  const setup = prepareAnalysis(params, FONTS[params.font].family, browserCanvasFactory);
  const pad = measureInkPadding(setup.glyphSet.atlasChars, setup.geometry, browserCanvasFactory);
  return { key: glyphKey(params), setup, pad };
}
