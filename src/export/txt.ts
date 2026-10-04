import { HALFTONE_TEXT_RAMP, halftoneTextIndex } from '../engine/charsets';
import type { GridSnapshot } from '../engine/types';

/** Halftone has no glyphs; text exports show its per-cell coverage on the engine's ' ·•●' ramp. */
export function halftoneChar(tone: number): string {
  return HALFTONE_TEXT_RAMP[Number.isFinite(tone) ? halftoneTextIndex(tone) : 0];
}

/** Exactly one printable code point per cell, whatever the snapshot holds. */
export function cellChar(snapshot: GridSnapshot, index: number): string {
  if (snapshot.params.mode === 'halftone') return halftoneChar(snapshot.tone[index]);
  const cp = snapshot.chars[index]?.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return ' ';
  return String.fromCodePoint(cp);
}

/** The grid as rows of exactly `cols` characters each. */
export function snapshotRows(snapshot: GridSnapshot): string[] {
  const rows: string[] = [];
  for (let r = 0; r < snapshot.rows; r++) {
    let line = '';
    for (let c = 0; c < snapshot.cols; c++) line += cellChar(snapshot, r * snapshot.cols + c);
    rows.push(line);
  }
  return rows;
}

/** UTF-8 text export: every row is exactly `cols` characters (trailing spaces kept) and ends with a line ending. */
export function snapshotToText(snapshot: GridSnapshot, lineEnding: '\n' | '\r\n' = '\n'): string {
  return snapshotRows(snapshot)
    .map((row) => row + lineEnding)
    .join('');
}
