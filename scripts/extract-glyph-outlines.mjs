#!/usr/bin/env node
/**
 * Extracts the glyph outlines of every character the bundled @fontsource subsets map (their cmap:
 * printable ASCII, Latin-1 and the punctuation / symbols of the latin subset, which includes every
 * preset character) into src/export/outlines/<fontId>.json, so SVG export can emit vector paths for
 * any character the engine draws with the font, without parsing fonts at runtime (and without
 * embedding OFL font data in the SVG). The keys double as the font's coverage for HTML export.
 *
 * Output: { fontId, unitsPerEm, ascender, descender, advance, glyphs: { [char]: d } } where d is
 * an absolute SVG path (M/L/Q/C/Z) in font units, y-up, pen at the origin ('' for a glyph without ink).
 *
 * Usage: node scripts/extract-glyph-outlines.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
// Node strips the TypeScript types; the presets are the single source of the character list.
import { CHARSET_PRESETS } from '../src/engine/charsets.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_IDS = ['jetbrains-mono', 'ibm-plex-mono', 'geist-mono'];
const PRESET_CHARS = [...new Set(Object.values(CHARSET_PRESETS).flatMap((preset) => [...preset]))];
// Control and format characters are never drawn into a cell (charsets.ts drops them too).
const DRAWABLE = (ch) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch);

/** Font units are integers for TrueType; implied on-curve points can land on .5. */
const num = (v) => String(Math.round(v * 100) / 100);

function pathData(commands) {
  let d = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        d += `M${num(c.x)} ${num(c.y)}`;
        startX = c.x;
        startY = c.y;
        break;
      case 'L':
        // opentype.js emits zero-length lines around implied on-curve points; they draw nothing.
        if (c.x === x && c.y === y) continue;
        d += `L${num(c.x)} ${num(c.y)}`;
        break;
      case 'Q':
        d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
        break;
      case 'C':
        d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
        break;
      case 'Z':
        d += 'Z';
        x = startX;
        y = startY;
        continue;
      default:
        throw new Error(`Unexpected path command ${c.type}`);
    }
    x = c.x;
    y = c.y;
  }
  return d;
}

for (const fontId of FONT_IDS) {
  const file = join(root, 'node_modules', '@fontsource', fontId, 'files', `${fontId}-latin-400-normal.woff`);
  const bytes = readFileSync(file);
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  // The cell advance: every preset character must have it (the grid is monospaced).
  const advance = font.charToGlyph('M').advanceWidth;
  for (const ch of PRESET_CHARS) {
    const glyph = font.charToGlyph(ch);
    if (!glyph || (glyph.index === 0 && ch !== ' ')) throw new Error(`${fontId}: missing glyph for ${JSON.stringify(ch)}`);
    if (glyph.advanceWidth !== advance) throw new Error(`${fontId}: ${JSON.stringify(ch)} is not monospaced`);
  }

  const glyphs = {};
  const skipped = [];
  const codePoints = Object.keys(font.tables.cmap.glyphIndexMap).map(Number).sort((a, b) => a - b);
  for (const cp of codePoints) {
    const ch = String.fromCodePoint(cp);
    if (!DRAWABLE(ch)) continue;
    const glyph = font.glyphs.get(font.tables.cmap.glyphIndexMap[cp]);
    // Zero-width marks and the like cannot fill a cell; they stay uncovered (a fallback draws them).
    if (glyph.advanceWidth !== advance) {
      skipped.push(ch);
      continue;
    }
    // glyph.path is in raw font units with y pointing up (getPath() would flip and scale it).
    glyphs[ch] = pathData(glyph.path.commands);
  }
  if (skipped.length) console.log(`${fontId}: skipped ${skipped.length} glyphs with another advance: ${skipped.join(' ')}`);

  const out = {
    fontId,
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    advance,
    glyphs,
  };
  const target = join(root, 'src', 'export', 'outlines', `${fontId}.json`);
  writeFileSync(target, `${JSON.stringify(out)}\n`);
  console.log(`${fontId}: ${Object.keys(glyphs).length} glyphs, ${(JSON.stringify(out).length / 1024).toFixed(1)} KiB -> ${target}`);
}
