/** Dock wording that depends on the render mode, glyph set or color mode, and the dock's tooltips. */
import type { CharsetPreset, ColorMode, DitherPattern, HalftoneShape, RenderMode } from '../../engine/types';

/** One line under the mode tiles: what the selected mode does. */
export const MODE_HINTS: Record<RenderMode, string> = {
  shape: 'Picks glyphs by each cell’s shape and brightness.',
  ramp: 'Picks glyphs by brightness only.',
  braille: 'Draws each cell as 2 × 4 braille dots.',
  halftone: 'Draws a grid of dots sized by brightness.',
  blocks: 'Draws each cell as 2 × 2 quarter blocks.',
};

/** Shape and Ramp can add the edge layer (contour strokes over the fill). */
export function hasEdgeLayer(mode: RenderMode): boolean {
  return mode === 'shape' || mode === 'ramp';
}

/** Modes that draw their own marks instead of matching glyphs from a glyph set. */
export const PROCEDURAL: Partial<Record<RenderMode, { note: string }>> = {
  braille: { note: 'Braille draws its own dot patterns.' },
  blocks: { note: 'Blocks draws its own block shapes.' },
  halftone: { note: 'Halftone draws dots.' },
};

export const CHARSETS: Record<CharsetPreset, { label: string }> = {
  ascii: { label: 'Full ASCII' },
  minimal: { label: 'Minimal' },
  dense: { label: 'Extended' },
  lines: { label: 'Lines' },
  custom: { label: 'Custom' },
};

export const COLOR_LABELS: Record<ColorMode, string> = { mono: 'Mono', source: 'Source', duotone: 'Duotone' };

export const DITHER_LABELS: Record<DitherPattern, string> = { none: 'None', ordered: 'Ordered', noise: 'Noise' };

export const DOT_SHAPE_LABELS: Record<HalftoneShape, string> = {
  round: 'Round',
  square: 'Square',
  diamond: 'Diamond',
  line: 'Line',
};

/**
 * Tooltips (final copy table). Slider tips get their range line from the control's own min, max and
 * step; numbers are glued to their word with a no-break space ("below 1").
 */
export const TIPS = {
  columns: 'Cells across the image.',
  brightness: 'Lightens or darkens the image.',
  contrast: 'Spreads light and dark apart above 1, pulls them together below 1.',
  gamma: 'Lightens midtones below 1, darkens them above 1.',
  edgeSharpness: 'Sharpens edges between neighboring cells.',
  dither: 'Adds fine grain to break up banding.',
  ditherPattern: 'How midtones become dots. Ordered is a regular pattern, Noise is irregular.',
  invert: 'Swaps light and dark',
  stability: 'Reduces flicker between frames.',
  edgeThreshold: 'Edge strength needed for a contour line. Higher draws fewer lines.',
  density: 'Glyphs in use, from least to most ink.',
  shapeSharpness: 'Exaggerates light and dark inside each cell.',
  halftoneAngle: 'Rotates the dot grid.',
  lineHeight: 'Cell height relative to the font size. Higher means fewer rows.',
  autoLevels: 'Stretches the image’s darkest and lightest tones to the full range.',
  shadowInk: 'Color of the faintest glyphs.',
  ink: 'Glyph color. In Duotone, the color of the densest glyphs.',
  paper: 'Background color.',
} as const;
