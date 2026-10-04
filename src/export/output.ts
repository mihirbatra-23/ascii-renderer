import type { AsciiEngine, GridSize, RasterOptions, RasterPixels } from '../engine/types';
import { ExportError, withAbort } from './errors';
import { fitsDevice, gridPixelSize, maxScale, normaliseMargin, normaliseScale, type PixelSize } from './geometry';

/** What a raster export renders and what it writes. */
export interface OutputPlan {
  /** The engine render: an integer scale, so every cell lands on whole pixels. */
  raster: RasterOptions;
  rasterSize: PixelSize;
  /** The file's size: the raster itself, or the exact target width after resampling (see needsResample). */
  size: PixelSize;
  /** The grid these pixels show, captured with the plan: file names must never come from a later getGrid(). */
  grid: GridSize;
}

export interface OutputRequest {
  scale: number;
  margin?: number;
  transparentBackground?: boolean;
  /** ExportOptions.targetWidth: an exact width that overrides `scale`. */
  targetWidth?: number;
}

/**
 * Scale and size for an exact target width: rendered at the next integer scale (so the resample only
 * ever shrinks, which keeps glyph edges crisp) and resampled to `targetWidth`; the height follows the
 * raster's aspect, rounded, so the aspect is kept to within half a pixel.
 */
export function targetSize(base: PixelSize, targetWidth: number): { scale: number; size: PixelSize } {
  const width = Math.max(1, Math.round(targetWidth));
  return {
    scale: Math.max(1, Math.ceil(width / base.width)),
    size: { width, height: Math.max(1, Math.round((width * base.height) / base.width)) },
  };
}

export function needsResample(plan: OutputPlan): boolean {
  return plan.size.width !== plan.rasterSize.width || plan.size.height !== plan.rasterSize.height;
}

/**
 * Normalises scale / margin / target width and checks the render size against the device limits up
 * front, so an oversized export fails with advice instead of a blank canvas.
 */
export function planOutput(engine: AsciiEngine, request: OutputRequest): OutputPlan {
  const margin = normaliseMargin(request.margin);
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  const base = gridPixelSize(grid, geometry, margin);
  const target = request.targetWidth !== undefined && Number.isFinite(request.targetWidth) ? targetSize(base, request.targetWidth) : null;
  const scale = target?.scale ?? normaliseScale(request.scale);
  const rasterSize = { width: base.width * scale, height: base.height * scale };
  if (!fitsDevice(rasterSize, engine.maxRasterSize)) {
    const best = maxScale(grid, geometry, margin, engine.maxRasterSize);
    throw new ExportError('too-large', tooLargeMessage(rasterSize, scale, best, base, engine.maxRasterSize, target !== null));
  }
  return {
    raster: { scale, margin, transparentBackground: request.transparentBackground ?? false },
    rasterSize,
    size: target?.size ?? rasterSize,
    grid: { cols: grid.cols, rows: grid.rows },
  };
}

function tooLargeMessage(size: PixelSize, scale: number, best: number, base: PixelSize, maxEdge: number, exactWidth: boolean): string {
  const what = exactWidth ? `That width is rendered at ${scale}× (${size.width} × ${size.height} px)` : `At ${scale}× the image would be ${size.width} × ${size.height} px`;
  const advice =
    best < 1
      ? 'Even 1× is too large here; reduce the columns or the margin.'
      : exactWidth
        ? `The widest this device can export is ${base.width * best} px.`
        : `Use ${best}× or lower.`;
  return `${what}, larger than this device can draw (${maxEdge} px per side). ${advice}`;
}

/** Warning text when the engine returned a raster that differs from the geometry formula. */
export function sizeMismatch(expected: PixelSize, actual: PixelSize): string | null {
  return expected.width === actual.width && expected.height === actual.height
    ? null
    : `Rendered ${actual.width} × ${actual.height} px instead of the expected ${expected.width} × ${expected.height} px.`;
}

/**
 * The engine's current grid at the plan's raster size, read back asynchronously (the engine renders
 * when called, so the source may be replaced as soon as this returns its promise). Rejects with
 * AbortError as soon as `signal` fires, and fails loudly if the engine's size disagrees with the plan.
 */
export async function readPlanned(engine: AsciiEngine, plan: OutputPlan, signal?: AbortSignal): Promise<RasterPixels> {
  const pixels = await withAbort(engine.readRaster(plan.raster), signal);
  const mismatch = sizeMismatch(plan.rasterSize, pixels);
  if (mismatch) throw new ExportError('encode-failed', mismatch);
  return pixels;
}
