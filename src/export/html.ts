import type { GridSnapshot } from '../engine/types';
import { cellBackgroundColors, cellInkColors, parseHex, toHex } from './color';
import { cssString, fontFaceCss, NO_LIGATURES_CSS, primaryFamily, type EmbeddedFont } from './font-embed';
import { gridPixelSize } from './geometry';
import { num } from './svg-number';
import { blocksSvg, brailleSvg, halftoneSvg } from './svg-shapes';
import { cellChar, snapshotRows } from './txt';

export interface HtmlExportOptions {
  /** Margin in px around the grid (scale 1). */
  margin?: number;
  /** Document title, usually the source file name. */
  title?: string;
  /** Font to inline; without it the page relies on the font being installed (falls back to monospace). */
  font?: EmbeddedFont | null;
  /**
   * Characters the font has glyphs for. Any other character is drawn by a fallback font with its own
   * advance, so its cell is given an explicit width to keep the grid exact. Omitted: all covered.
   */
  covered?: ReadonlySet<string>;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Run {
  fg: number | null;
  text: string;
}

/** Splits one row into runs of equal colour; a space has no visible colour, so it joins whatever run it touches. */
function rowRuns(snapshot: GridSnapshot, row: number, fg: Uint32Array, covered: ReadonlySet<string> | undefined): Run[] {
  const runs: Run[] = [];
  for (let c = 0; c < snapshot.cols; c++) {
    const i = row * snapshot.cols + c;
    const ch = cellChar(snapshot, i);
    const text = covered && ch !== ' ' && !covered.has(ch) ? `<span class="u">${escapeHtml(ch)}</span>` : escapeHtml(ch);
    const last = runs[runs.length - 1];
    if (ch === ' ') {
      if (last) last.text += text;
      else runs.push({ fg: null, text });
    } else if (last && (last.fg === fg[i] || last.fg === null)) {
      last.fg = fg[i];
      last.text += text;
    } else {
      runs.push({ fg: fg[i], text });
    }
  }
  return runs;
}

function page(title: string | undefined, css: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title ?? 'ASCII art')}</title>\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`
  );
}

/**
 * Standalone HTML page at exactly the PNG's 1× size (cols·cellW + 2m) × (rows·cellH + 2m).
 *
 * Glyph modes are a <pre> laid out with the shared cell geometry: the font size makes the advance
 * exactly cellW, and each line opens with an empty inline-block strut cellH tall, lowered so the
 * baseline sits exactly `geometry.baseline` px below the line's top. With line-height 0 nothing else
 * contributes to the line box, so rows are exactly cellH apart and glyphs land on the raster's
 * baseline in every browser (CSS half-leading rounds ascent and descent separately, which put text
 * 1 px off for some fonts). Characters the font lacks get an explicit cell width.
 *
 * Braille, blocks and halftone are drawn by the engine as shapes, not font glyphs (no bundled font
 * has them, and fallbacks are up to 14% wider), so the page embeds the same shapes as the SVG export
 * plus an invisible, selectable text layer whose rows are stretched to the grid width.
 */
export function snapshotToHtml(snapshot: GridSnapshot, options: HtmlExportOptions = {}): string {
  switch (snapshot.params.mode) {
    case 'braille':
    case 'blocks':
    case 'halftone':
      return shapesPage(snapshot, options);
    default:
      return glyphPage(snapshot, options);
  }
}

function glyphPage(snapshot: GridSnapshot, options: HtmlExportOptions): string {
  const { geometry, params } = snapshot;
  const margin = options.margin ?? 0;
  const ink = parseHex(params.ink);
  const paper = toHex(parseHex(params.paper));
  const family = options.font?.family ?? primaryFamily(geometry.fontFamily);
  const fg = cellInkColors(snapshot);

  const lines: string[] = [];
  for (let r = 0; r < snapshot.rows; r++) {
    let line = '<i></i>';
    for (const run of rowRuns(snapshot, r, fg, options.covered)) {
      line += run.fg === null || run.fg === ink ? run.text : `<span style="color:${toHex(run.fg)}">${run.text}</span>`;
    }
    lines.push(line);
  }

  const css = [
    options.font ? fontFaceCss(options.font) : '',
    `html,body{margin:0;background:${paper}}`,
    `pre{margin:0;padding:${margin}px;width:max-content;background:${paper};color:${toHex(ink)};` +
      `font-family:${cssString(family)},ui-monospace,monospace;font-size:${round(geometry.fontSize, 6)}px;` +
      `line-height:0;letter-spacing:0;white-space:pre;${NO_LIGATURES_CSS};` +
      '-webkit-text-size-adjust:none;text-size-adjust:none}',
    // The strut sets each line's box: cellH tall, baseline `baseline` px below its top.
    `pre i{display:inline-block;width:0;height:${geometry.cellH}px;vertical-align:${geometry.baseline - geometry.cellH}px}`,
    `pre .u{display:inline-block;width:${geometry.cellW}px}`,
  ].join('\n');
  return page(options.title, css, `<pre>${lines.join('\n')}</pre>`);
}

function shapesPage(snapshot: GridSnapshot, options: HtmlExportOptions): string {
  const { geometry, params } = snapshot;
  const margin = options.margin ?? 0;
  const { width, height } = gridPixelSize(snapshot, geometry, margin);
  const paper = toHex(parseHex(params.paper));
  const fg = cellInkColors(snapshot);
  const shapes =
    params.mode === 'braille'
      ? brailleSvg(snapshot, fg, margin)
      : params.mode === 'blocks'
        ? blocksSvg(snapshot, fg, cellBackgroundColors(snapshot), margin)
        : halftoneSvg(snapshot, fg, margin);

  // Selectable copy of the characters (TXT's), invisible, each row stretched to exactly the grid width.
  const rowWidth = snapshot.cols * geometry.cellW;
  let text = '';
  snapshotRows(snapshot).forEach((row, r) => {
    text +=
      `<text x="${margin}" y="${num(margin + r * geometry.cellH + geometry.baseline)}" textLength="${rowWidth}" ` +
      `lengthAdjust="spacingAndGlyphs">${escapeHtml(row)}</text>`;
  });
  const textLayer = `<g fill="transparent" font-family="monospace" font-size="${round(geometry.fontSize, 4)}">${text}</g>`;

  const css = [`html,body{margin:0;background:${paper}}`, 'svg{display:block}', 'text{white-space:pre}'].join('\n');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${paper}"/>${shapes}${textLayer}</svg>`;
  return page(options.title, css, svg);
}

function round(value: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}
