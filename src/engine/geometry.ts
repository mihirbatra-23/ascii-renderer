/**
 * Cell geometry (docs/ALGORITHM.md §1): the single source of truth for grid, analysis and raster sizes.
 *
 * Public API
 *   measureFontMetrics(ctx, family)          → FontMetrics (advance / ascent / descent in em)
 *   computeGeometry(metrics, options)        → CellGeometry
 *   gridSize(srcW, srcH, cols, geometry)     → GridSize (rows from the source aspect, limits applied)
 *   analysisSize(grid, geometry)             → AnalysisSize (SW × SH sub-grid per cell)
 *   rasterSize(grid, geometry, { scale, margin }) → exact export size in px
 *   GRID_LIMITS, DEFAULT_CELL_W
 */
import type { CellGeometry, GridSize } from './types';
import { SW } from './layout';

export interface FontMetrics {
  advanceEm: number;
  ascentEm: number;
  descentEm: number;
}

/** The subset of a 2D context needed to measure a font (DOM, OffscreenCanvas or @napi-rs/canvas). */
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number };
}

export const DEFAULT_CELL_W = 8;

export const GRID_LIMITS = { minCols: 20, maxCols: 400, maxRows: 400, maxCells: 120_000 } as const;

const MEASURE_PX = 100;

/** Advance from a run of 100 'M's (never from ink bounds); ascent/descent from the font's bounding box. */
export function measureFontMetrics(ctx: TextMeasurer, family: string): FontMetrics {
  ctx.font = `${MEASURE_PX}px ${family}`;
  const m = ctx.measureText('M'.repeat(100));
  return {
    advanceEm: m.width / 100 / MEASURE_PX,
    ascentEm: m.fontBoundingBoxAscent / MEASURE_PX,
    descentEm: m.fontBoundingBoxDescent / MEASURE_PX,
  };
}

export interface GeometryOptions {
  /** Base cell width in px at scale 1 (default 8). */
  cellW?: number;
  /** Line-height factor (default 1.2). */
  lineHeight: number;
  /** CSS font-family string, e.g. '"JetBrains Mono"'. */
  family: string;
}

export function computeGeometry(metrics: FontMetrics, options: GeometryOptions): CellGeometry {
  const cellW = options.cellW ?? DEFAULT_CELL_W;
  const k = options.lineHeight / metrics.advanceEm;
  const cellH = Math.max(1, Math.round(cellW * k));
  const fontSize = cellW / metrics.advanceEm;
  const ascent = metrics.ascentEm * fontSize;
  const descent = metrics.descentEm * fontSize;
  return {
    cellW,
    cellH,
    fontSize,
    baseline: Math.round((cellH - (ascent + descent)) / 2 + ascent),
    fontFamily: options.family,
    advanceEm: metrics.advanceEm,
  };
}

/**
 * rows = round(cols · H/W · cellW/cellH). When rows or cols·rows would exceed the limits, the
 * column count is reduced (never the row count alone), so the output keeps the source aspect;
 * only sources taller than ~400:1 end up with clamped rows.
 */
export function gridSize(srcW: number, srcH: number, cols: number, geometry: CellGeometry): GridSize {
  const rowsPerCol = (srcH / srcW) * (geometry.cellW / geometry.cellH);
  const rowsFor = (c: number) => Math.max(1, Math.round(c * rowsPerCol));
  let c = Math.min(GRID_LIMITS.maxCols, Math.max(GRID_LIMITS.minCols, Math.round(cols)));
  let r = rowsFor(c);
  if (r > GRID_LIMITS.maxRows || c * r > GRID_LIMITS.maxCells) {
    c = Math.max(
      1,
      Math.min(c, Math.floor(GRID_LIMITS.maxRows / rowsPerCol), Math.floor(Math.sqrt(GRID_LIMITS.maxCells / rowsPerCol))),
    );
    r = rowsFor(c);
    while (c > 1 && (r > GRID_LIMITS.maxRows || c * r > GRID_LIMITS.maxCells)) r = rowsFor(--c);
    r = Math.min(r, GRID_LIMITS.maxRows);
  }
  return { cols: c, rows: r };
}

export interface AnalysisSize {
  /** Analysis pixels per cell. */
  sw: number;
  sh: number;
  /** Analysis image size: cols·sw × rows·sh. */
  width: number;
  height: number;
}

/**
 * SH = round(SW · cellH / cellW): equal to the spec's round(8·k) at the default cellW = 8, and
 * follows the real integer cell (so analysis pixels stay square) for other cell widths.
 */
export function analysisSize(grid: GridSize, geometry: CellGeometry): AnalysisSize {
  const sh = Math.max(4, Math.round((SW * geometry.cellH) / geometry.cellW));
  return { sw: SW, sh, width: grid.cols * SW, height: grid.rows * sh };
}

export function rasterSize(
  grid: GridSize,
  geometry: CellGeometry,
  options: { scale: number; margin?: number },
): { width: number; height: number } {
  const m = options.margin ?? 0;
  return {
    width: (grid.cols * geometry.cellW + 2 * m) * options.scale,
    height: (grid.rows * geometry.cellH + 2 * m) * options.scale,
  };
}
