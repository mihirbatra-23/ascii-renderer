import type { GridSnapshot } from '../engine/types';
import { exportFileName } from './filename';
import type { EmbeddedFont } from './font-embed';
import { bundledFont } from './fonts';
import { gridPixelSize } from './geometry';
import { snapshotToHtml } from './html';
import { loadOutlines } from './outlines';
import { snapshotToSvg } from './svg';
import { snapshotToText } from './txt';
import type { ExportOptions, ExportResult } from './types';

/** File-producing wrappers around the pure text/vector builders. */

interface Naming {
  /** Source file name, for the download name. */
  sourceName?: string;
}

interface FontEmbedding {
  /** Font to inline. Defaults to the snapshot's bundled font; null leaves it out. */
  font?: EmbeddedFont | null;
}

export type TxtExportOptions = Pick<ExportOptions, 'lineEnding'> & Naming;
export type HtmlExportFileOptions = Pick<ExportOptions, 'margin'> & Naming & FontEmbedding;
export type SvgExportFileOptions = Pick<ExportOptions, 'margin' | 'transparentBackground' | 'svgText'> & Naming & FontEmbedding;

function resolveFont(snapshot: GridSnapshot, font: EmbeddedFont | null | undefined): Promise<EmbeddedFont | null> {
  return font === undefined ? bundledFont(snapshot.params.font) : Promise.resolve(font);
}

export function exportTxt(snapshot: GridSnapshot, opts: TxtExportOptions): ExportResult {
  return {
    blob: new Blob([snapshotToText(snapshot, opts.lineEnding)], { type: 'text/plain;charset=utf-8' }),
    fileName: exportFileName(opts.sourceName ?? 'image', snapshot, 'txt'),
    warnings: [],
  };
}

/** Shape, ramp: glyphs from the font. Braille, blocks, halftone: shapes drawn by the engine. */
function usesFontGlyphs(snapshot: GridSnapshot): boolean {
  return snapshot.params.mode === 'shape' || snapshot.params.mode === 'ramp';
}

export async function exportHtml(snapshot: GridSnapshot, opts: HtmlExportFileOptions): Promise<ExportResult> {
  const glyphs = usesFontGlyphs(snapshot);
  const [font, outlines] = glyphs ? await Promise.all([resolveFont(snapshot, opts.font), loadOutlines(snapshot.params.font)]) : [null, null];
  const html = snapshotToHtml(snapshot, {
    margin: opts.margin,
    title: opts.sourceName,
    font,
    covered: outlines ? new Set(Object.keys(outlines.glyphs)) : undefined,
  });
  const size = gridPixelSize(snapshot, snapshot.geometry, opts.margin);
  return {
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    fileName: exportFileName(opts.sourceName ?? 'image', snapshot, 'html'),
    width: size.width,
    height: size.height,
    warnings: glyphs && !font ? ['The font is not embedded; the page uses the viewer’s monospace font.'] : [],
  };
}

export async function exportSvg(snapshot: GridSnapshot, opts: SvgExportFileOptions): Promise<ExportResult> {
  const glyphMode = usesFontGlyphs(snapshot);
  const asText = glyphMode && opts.svgText === 'text';
  const [outlines, font] = await Promise.all([
    glyphMode && !asText ? loadOutlines(snapshot.params.font) : undefined,
    asText ? resolveFont(snapshot, opts.font) : null,
  ]);
  const { svg, warnings } = snapshotToSvg(snapshot, {
    margin: opts.margin,
    transparentBackground: opts.transparentBackground,
    svgText: opts.svgText,
    outlines,
    font,
  });
  const size = gridPixelSize(snapshot, snapshot.geometry, opts.margin);
  return {
    blob: new Blob([svg], { type: 'image/svg+xml' }),
    fileName: exportFileName(opts.sourceName ?? 'image', snapshot, 'svg'),
    width: size.width,
    height: size.height,
    warnings,
  };
}
