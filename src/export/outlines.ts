import type { FontId } from '../engine/types';

/**
 * Pre-extracted glyph outlines (scripts/extract-glyph-outlines.mjs): absolute M/L/Q/C/Z path data
 * in font units, y-up, pen at the origin, for every character the bundled font subset maps (so the
 * keys are also the font's coverage; an empty path is a glyph without ink, such as the space).
 * Characters outside it come from a fallback font: SVG keeps them as text, HTML gives them a fixed
 * cell width.
 */
export interface GlyphOutlines {
  fontId: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Advance width in font units (all glyphs; the fonts are monospaced). */
  advance: number;
  glyphs: Record<string, string>;
}

// Lazy so the ~25 KiB per font is only fetched when someone exports SVG.
const LOADERS: Record<FontId, () => Promise<{ default: unknown }>> = {
  'jetbrains-mono': () => import('./outlines/jetbrains-mono.json'),
  'ibm-plex-mono': () => import('./outlines/ibm-plex-mono.json'),
  'geist-mono': () => import('./outlines/geist-mono.json'),
};

export async function loadOutlines(fontId: FontId): Promise<GlyphOutlines> {
  const loader = LOADERS[fontId];
  if (!loader) throw new Error(`No glyph outlines for font ${fontId}`);
  return (await loader()).default as GlyphOutlines;
}
