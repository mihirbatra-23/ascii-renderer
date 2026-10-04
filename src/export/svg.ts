import type { GridSnapshot } from '../engine/types';
import { cellBackgroundColors, cellInkColors, parseHex, toHex } from './color';
import { cssString, fontFaceCss, NO_LIGATURES_CSS, primaryFamily, type EmbeddedFont } from './font-embed';
import { gridPixelSize } from './geometry';
import { escapeHtml as escapeXml } from './html';
import type { GlyphOutlines } from './outlines';
import { GlyphPaths } from './svg-glyphs';
import { num, toHundredths } from './svg-number';
import { blocksSvg, brailleSvg, halftoneSvg } from './svg-shapes';
import { cellChar } from './txt';

export interface SvgExportOptions {
  /** Margin in px around the grid (scale 1). */
  margin?: number;
  transparentBackground?: boolean;
  /** 'outlines' (default) emits glyphs as vector paths; 'text' emits one <text> per row. */
  svgText?: 'outlines' | 'text';
  /** Required for glyph modes with svgText 'outlines' (see loadOutlines). */
  outlines?: GlyphOutlines;
  /** Font inlined for svgText 'text'. */
  font?: EmbeddedFont | null;
}

export interface SvgExport {
  svg: string;
  /** User-facing notes, e.g. characters that have no outline in the bundled font. */
  warnings: string[];
}

/**
 * SVG of the grid at scale 1: size and viewBox are exactly (cols·cellW + 2m) × (rows·cellH + 2m),
 * glyph (r, c) has its pen at (m + c·cellW, m + r·cellH + baseline), as in the raster.
 * Glyph modes become one compound <path> per colour (pastes into Figma as vector layers) or
 * live <text>; braille / blocks / halftone are always drawn as shapes, like the raster.
 */
export function snapshotToSvg(snapshot: GridSnapshot, options: SvgExportOptions = {}): SvgExport {
  const margin = options.margin ?? 0;
  const { width, height } = gridPixelSize(snapshot, snapshot.geometry, margin);
  const { params } = snapshot;
  const fg = cellInkColors(snapshot);
  const warnings: string[] = [];

  let body: string;
  switch (params.mode) {
    case 'braille':
      body = brailleSvg(snapshot, fg, margin);
      break;
    case 'blocks':
      body = blocksSvg(snapshot, fg, cellBackgroundColors(snapshot), margin);
      break;
    case 'halftone':
      body = halftoneSvg(snapshot, fg, margin);
      break;
    default:
      body =
        options.svgText === 'text'
          ? textRows(snapshot, fg, margin, options.font ?? null)
          : outlinePaths(snapshot, fg, margin, options.outlines, warnings);
  }

  const background = options.transparentBackground
    ? ''
    : `<rect width="${width}" height="${height}" fill="${toHex(parseHex(params.paper))}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${background}${body}</svg>\n`;
  return { svg, warnings };
}

function outlinePaths(
  snapshot: GridSnapshot,
  fg: Uint32Array,
  margin: number,
  outlines: GlyphOutlines | undefined,
  warnings: string[],
): string {
  if (!outlines) throw new Error('snapshotToSvg: glyph outlines are required for svgText "outlines"');
  const { cellW, cellH, baseline, fontSize, fontFamily } = snapshot.geometry;
  const paths = new GlyphPaths(outlines, fontSize);
  const byColor = new Map<number, string[]>();
  // Characters the font has no glyph for (custom charsets): the engine draws them with a fallback
  // font, so they are kept as text in that cell rather than left blank.
  const fallback = new Map<number, string[]>();
  const missing = new Set<string>();
  const add = (map: Map<number, string[]>, color: number, item: string) => {
    const list = map.get(color);
    if (list) list.push(item);
    else map.set(color, [item]);
  };

  for (let r = 0; r < snapshot.rows; r++) {
    const yPx = margin + r * cellH + baseline;
    const y = toHundredths(yPx);
    for (let c = 0; c < snapshot.cols; c++) {
      const i = r * snapshot.cols + c;
      const ch = cellChar(snapshot, i);
      if (ch === ' ') continue;
      if (!paths.has(ch)) {
        missing.add(ch);
        add(fallback, fg[i], `<text x="${num(margin + c * cellW)}" y="${num(yPx)}">${escapeXml(ch)}</text>`);
        continue;
      }
      const d = paths.place(ch, toHundredths(margin + c * cellW), y);
      if (d) add(byColor, fg[i], d);
    }
  }
  let out = '';
  for (const [color, ds] of byColor) out += `<path fill="${toHex(color)}" d="${ds.join('')}"/>`;
  if (fallback.size > 0) {
    const name = primaryFamily(fontFamily);
    out += `<g font-family="${escapeXml(`${cssString(name)}, monospace`)}" font-size="${Math.round(fontSize * 1e4) / 1e4}" style="${escapeXml(NO_LIGATURES_CSS)}">`;
    for (const [color, texts] of fallback) out += `<g fill="${toHex(color)}">${texts.join('')}</g>`;
    out += '</g>';
    const list = [...missing].map((ch) => `“${ch}”`).join(' ');
    warnings.push(`${list} ${missing.size === 1 ? 'isn’t' : 'aren’t'} in ${name}, so ${missing.size === 1 ? 'it is' : 'they are'} kept as text drawn by the viewer’s fonts.`);
  }
  return out;
}

function textRows(snapshot: GridSnapshot, fg: Uint32Array, margin: number, font: EmbeddedFont | null): string {
  const { cellW, cellH, baseline, fontSize, fontFamily } = snapshot.geometry;
  const family = font?.family ?? primaryFamily(fontFamily);
  const ink = parseHex(snapshot.params.ink);
  const style = font ? `<defs><style>${fontFaceCss(font)}</style></defs>` : '';
  const textLength = snapshot.cols * cellW;
  let rows = '';
  for (let r = 0; r < snapshot.rows; r++) {
    let content = '';
    let runColor: number | null = null;
    let runText = '';
    const flush = () => {
      if (!runText) return;
      const text = escapeXml(runText);
      content += runColor === null || runColor === ink ? text : `<tspan fill="${toHex(runColor)}">${text}</tspan>`;
      runText = '';
    };
    for (let c = 0; c < snapshot.cols; c++) {
      const i = r * snapshot.cols + c;
      const ch = cellChar(snapshot, i);
      // Spaces have no visible colour: let them extend the current run.
      if (ch !== ' ' && fg[i] !== runColor) {
        flush();
        runColor = fg[i];
      }
      runText += ch;
    }
    flush();
    rows +=
      `<text x="${margin}" y="${num(margin + r * cellH + baseline)}" textLength="${textLength}" ` +
      `lengthAdjust="spacing" xml:space="preserve">${content}</text>`;
  }
  const attrs =
    `font-family="${escapeXml(`${cssString(family)}, monospace`)}" font-size="${Math.round(fontSize * 1e4) / 1e4}" ` +
    `fill="${toHex(ink)}" style="${escapeXml(NO_LIGATURES_CSS)};white-space:pre"`;
  return `${style}<g ${attrs}>${rows}</g>`;
}
