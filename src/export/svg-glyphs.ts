import type { GlyphOutlines } from './outlines';
import { formatHundredths, joinNumbers } from './svg-number';

/**
 * A glyph pre-transformed to px at the export font size (y flipped to SVG's y-down), stored as its
 * first point plus the rest of the outline in relative commands. Placing it in a cell then costs
 * one absolute `M`; because every point is snapped to 1/100 px before the deltas are taken, the
 * relative form reproduces the snapped absolute coordinates exactly (no accumulated drift).
 */
export interface CompiledGlyph {
  /** First point in hundredths of a px, relative to the pen (baseline origin). */
  x0: number;
  y0: number;
  /** Remaining path data in relative commands. */
  rel: string;
}

const TOKEN = /[MLQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const ARITY: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };

/** Parses and transforms one glyph; null for glyphs without ink (space). */
export function compileGlyph(d: string, scale: number): CompiledGlyph | null {
  const tokens = d.match(TOKEN) ?? [];
  let first: { x: number; y: number } | null = null;
  let rel = '';
  let lastCmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;

  for (let t = 0; t < tokens.length; ) {
    const cmd = tokens[t++].toUpperCase();
    const arity = ARITY[cmd];
    if (arity === undefined) throw new Error(`Unsupported path command ${cmd}`);
    if (cmd === 'Z') {
      rel += 'z';
      lastCmd = 'z';
      cx = sx;
      cy = sy;
      continue;
    }
    const pts: number[] = [];
    for (let k = 0; k < arity; k += 2) {
      pts.push(Math.round(Number(tokens[t++]) * scale * 100), Math.round(-Number(tokens[t++]) * scale * 100));
    }
    if (cmd === 'M') {
      sx = pts[0];
      sy = pts[1];
      if (!first) {
        first = { x: sx, y: sy };
      } else {
        rel += `m${joinNumbers([formatHundredths(sx - cx), formatHundredths(sy - cy)])}`;
        lastCmd = 'm';
      }
      cx = sx;
      cy = sy;
      continue;
    }
    const letter = cmd.toLowerCase();
    const parts: string[] = [];
    for (let k = 0; k < pts.length; k += 2) parts.push(formatHundredths(pts[k] - cx), formatHundredths(pts[k + 1] - cy));
    const body = joinNumbers(parts);
    // A repeated command (or a lineto right after a moveto) may omit its letter.
    const implicit = letter === lastCmd || (letter === 'l' && lastCmd === 'm');
    rel += implicit ? (body.startsWith('-') ? body : ` ${body}`) : letter + body;
    lastCmd = letter;
    cx = pts[pts.length - 2];
    cy = pts[pts.length - 1];
  }
  return first ? { x0: first.x, y0: first.y, rel } : null;
}

/** Glyph outlines compiled for one font size, cached per character. */
export class GlyphPaths {
  private readonly cache = new Map<string, CompiledGlyph | null>();
  private readonly scale: number;

  constructor(
    private readonly outlines: GlyphOutlines,
    fontSize: number,
  ) {
    this.scale = fontSize / outlines.unitsPerEm;
  }

  has(ch: string): boolean {
    return ch in this.outlines.glyphs;
  }

  /** Path data for `ch` with its pen at (x, y) given in hundredths of a px; '' when the glyph has no ink. */
  place(ch: string, x: number, y: number): string {
    let glyph = this.cache.get(ch);
    if (glyph === undefined) {
      const d = this.outlines.glyphs[ch];
      glyph = d ? compileGlyph(d, this.scale) : null;
      this.cache.set(ch, glyph);
    }
    if (!glyph) return '';
    return `M${joinNumbers([formatHundredths(x + glyph.x0), formatHundredths(y + glyph.y0)])}${glyph.rel}`;
  }
}
