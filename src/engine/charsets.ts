/**
 * Character sets and the fixed tables of the procedural modes (docs/ALGORITHM.md §4, §6).
 *
 * Public API
 *   CHARSET_PRESETS               preset id → characters (custom is resolved from params)
 *   MAX_GLYPHS                    upper bound on a resolved charset (256)
 *   resolveCharset(params)        → string[]: one entry per code point, space first, deduplicated
 *   BRAILLE_BITS, brailleChar     braille dot (dx, dy) → bit, bits → character
 *   QUADRANT_CHARS, quadrantChar  2×2 block bits (TL=1, TR=2, BL=4, BR=8) → character
 *   HALFTONE_TEXT_RAMP, halftoneTextIndex  coverage → ' ·•●' for TXT / HTML export of halftone
 *   rampCharset(params)           ramp mode's curated glyphs for the shape-matching presets, else undefined
 *   rampOrder(meanCoverage)       glyph indices sorted by mean coverage (ties by index)
 *   EDGE_STROKES, EdgeStroke      the edge layer's stroke glyphs and their indices (§5b)
 */
import type { CharsetPreset, RenderParams } from './types';

const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');

export const CHARSET_PRESETS: Record<Exclude<CharsetPreset, 'custom'>, string> = {
  ascii: PRINTABLE_ASCII,
  /** A short classic tonal ramp. */
  minimal: ' .:-=+*#%@',
  /** ASCII plus the Latin-1 / punctuation symbols present in all bundled fonts: more shapes to match. */
  dense: PRINTABLE_ASCII + '¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿×÷ÆØßæðøþ‘’“”„•…‹›€™',
  /** Strokes only: renders edges and contours as line art. */
  lines: " .'`,-_|/\\",
};

export const MAX_GLYPHS = 256;

/**
 * Ramp mode's glyphs for the presets made for shape matching (Full ASCII, Dense). Ramp matches tone
 * alone, and among 95+ glyphs neighbouring tones are different letters whose coverage differs by
 * less than dither or codec noise, so flat areas read as random text. The classic tonal ramp (the
 * Minimal preset's characters, all in both presets) steps evenly from paper to ink instead.
 */
export function rampCharset(params: Pick<RenderParams, 'charsetPreset'>): readonly string[] | undefined {
  return params.charsetPreset === 'ascii' || params.charsetPreset === 'dense' ? [...CHARSET_PRESETS.minimal] : undefined;
}

// Control, format, separator and non-space whitespace code points cannot be drawn into a cell.
const UNDRAWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]|(?! )\s/u;

/**
 * The glyph candidates for the params: space first, one entry per code point, duplicates and
 * undrawable characters removed, capped at MAX_GLYPHS. A custom set without any visible
 * character falls back to printable ASCII.
 */
export function resolveCharset(params: Pick<RenderParams, 'charsetPreset' | 'customCharset'>): string[] {
  const source = params.charsetPreset === 'custom' ? params.customCharset : CHARSET_PRESETS[params.charsetPreset];
  const seen = new Set<string>([' ']);
  const out = [' '];
  for (const ch of source) {
    if (out.length >= MAX_GLYPHS) break;
    if (seen.has(ch) || UNDRAWABLE.test(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  if (out.length < 2 && params.charsetPreset === 'custom') return resolveCharset({ charsetPreset: 'ascii', customCharset: '' });
  return out;
}

/** BRAILLE_BITS[dy][dx]: bit of the dot in column dx (0..1), row dy (0..3). */
export const BRAILLE_BITS: readonly (readonly number[])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export function brailleChar(bits: number): string {
  return String.fromCharCode(0x2800 + (bits & 0xff));
}

/** Indexed by quadrant bits: TL=1, TR=2, BL=4, BR=8. */
export const QUADRANT_CHARS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';

export function quadrantChar(bits: number): string {
  return QUADRANT_CHARS[bits & 15];
}

export const HALFTONE_TEXT_RAMP = ' ·•●';

export function halftoneTextIndex(coverage: number): number {
  return Math.min(3, Math.max(0, Math.round(coverage * 3)));
}

export function rampOrder(meanCoverage: ArrayLike<number>): Uint16Array {
  const idx = Array.from({ length: meanCoverage.length }, (_, i) => i);
  idx.sort((a, b) => meanCoverage[a] - meanCoverage[b] || a - b);
  return Uint16Array.from(idx);
}

/**
 * The edge layer's strokes (docs/ALGORITHM.md §5b), indexed by EdgeStroke: one per orientation bin
 * ('|', '/', '\\', '-') plus '_' for a horizontal edge low in the cell. They are always drawable,
 * whatever the charset (GlyphSet.atlasChars appends any the charset lacks).
 */
export const EDGE_STROKES = ['|', '/', '\\', '-', '_'] as const;

/** Index into EDGE_STROKES. The first four are the orientation bins of §5b. */
export const EdgeStroke = { vertical: 0, rising: 1, falling: 2, horizontal: 3, low: 4 } as const;
