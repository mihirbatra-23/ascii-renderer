import { rasterSize } from '../engine/geometry';
import type { CellGeometry, GridSize } from '../engine/types';

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * Largest canvas area browsers reliably allocate (Chrome/Firefox: 2^28 px). Above it a canvas
 * silently comes back blank, so it is checked alongside the engine's edge limit.
 */
export const MAX_CANVAS_AREA = 268_435_456;

/** Scale-1 size of the grid plus margin: the SVG viewBox and the base of every raster size. */
export function gridPixelSize(grid: GridSize, geometry: CellGeometry, margin = 0): PixelSize {
  return rasterSize(grid, geometry, { scale: 1, margin });
}

/** Raster scales are integers ≥ 1 so cells stay on whole pixels. */
export function normaliseScale(scale: number): number {
  return Number.isFinite(scale) ? Math.max(1, Math.round(scale)) : 1;
}

export function normaliseMargin(margin: number | undefined): number {
  return margin !== undefined && Number.isFinite(margin) ? Math.max(0, Math.round(margin)) : 0;
}

export function fitsDevice(size: PixelSize, maxEdge: number): boolean {
  return size.width <= maxEdge && size.height <= maxEdge && size.width * size.height <= MAX_CANVAS_AREA;
}

/** Largest integer scale that fits the device (0 if not even scale 1 does). */
export function maxScale(grid: GridSize, geometry: CellGeometry, margin: number, maxEdge: number): number {
  const base = gridPixelSize(grid, geometry, margin);
  const byEdge = Math.floor(maxEdge / Math.max(base.width, base.height));
  const byArea = Math.floor(Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)));
  return Math.max(0, Math.min(byEdge, byArea));
}

/** Video encoders need even dimensions; the extra row/column is padded, never scaled. */
export function evenSize(size: PixelSize): PixelSize {
  return { width: size.width + (size.width % 2), height: size.height + (size.height % 2) };
}
