/** Dock wording that depends on the render mode, charset or colour mode (design spec §4.2, §11). */
import type { CharsetPreset, ColorMode, DitherPattern, HalftoneShape, RenderMode } from '../../engine/types';

/** One line under the mode tiles: what the selected mode does. */
export const MODE_HINTS: Record<RenderMode, string> = {
  shape: 'Matches each cell’s shape, so edges read as lines.',
  ramp: 'Picks glyphs by density alone. The classic look.',
  braille: '2 × 4 dots per cell. Fine detail at small sizes.',
  halftone: 'Dots sized by tone on an angled screen, like print.',
  blocks: '2 × 2 quadrant blocks per cell. Bold and graphic.',
};

/** Shape and Ramp can add the edge layer; the mode hint says so while it is on. */
export function hasEdgeLayer(mode: RenderMode): boolean {
  return mode === 'shape' || mode === 'ramp';
}

export const MODE_HINTS_WITH_EDGES: Partial<Record<RenderMode, string>> = {
  shape: 'Matches each cell’s shape; strong edges also get contour strokes.',
  ramp: 'Picks glyphs by density, with contour strokes on strong edges.',
};

/** The collapsed Advanced row lists what it holds for the current mode. */
export const ADVANCED_SUMMARY: Record<RenderMode, string> = {
  shape: 'Dither, font, cell, line height',
  ramp: 'Font, cell, line height',
  braille: 'Cell, line height, levels',
  halftone: 'Dot shape, angle, cell, line height',
  blocks: 'Cell, line height, levels',
};

/** Modes that draw their own marks instead of matching glyphs from a character set. */
export const PROCEDURAL: Partial<Record<RenderMode, { aux: string; line: string; note: string }>> = {
  braille: { aux: '256 patterns', line: 'Dot patterns · 256', note: 'Braille draws its own 2 × 4 dot patterns.' },
  blocks: { aux: '16 blocks', line: 'Quadrant blocks · 16', note: 'Blocks draws its own 2 × 2 quadrant shapes.' },
  halftone: { aux: 'no glyphs', line: 'Dots, no glyphs', note: 'Halftone draws dots, not glyphs.' },
};

export const CHARSETS: Record<CharsetPreset, { label: string; aux: string }> = {
  ascii: { label: 'Full ASCII', aux: 'printable' },
  minimal: { label: 'Minimal', aux: 'tonal ramp' },
  dense: { label: 'Dense', aux: 'ASCII + Latin-1' },
  lines: { label: 'Lines', aux: 'strokes' },
  custom: { label: 'Custom', aux: 'your glyphs' },
};

export const COLOR_LABELS: Record<ColorMode, string> = { mono: 'Mono', source: 'Source', duotone: 'Duotone' };

export const DITHER_LABELS: Record<DitherPattern, string> = { none: 'None', ordered: 'Ordered', noise: 'Noise' };

export const DOT_SHAPE_LABELS: Record<HalftoneShape, string> = {
  round: 'Round',
  square: 'Square',
  diamond: 'Diamond',
  line: 'Line',
};
