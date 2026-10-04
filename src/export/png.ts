import type { AsciiEngine } from '../engine/types';
import { exportFileName } from './filename';
import { planOutput, readPlanned } from './output';
import { RasterWorker } from './raster-worker';
import type { ExportOptions, ExportResult } from './types';

export interface PngExportOptions extends Pick<ExportOptions, 'scale' | 'margin' | 'transparentBackground' | 'targetWidth'> {
  /** Source file name, for the download name. */
  sourceName?: string;
}

/**
 * PNG of the current grid at exactly (cols·cellW + 2m)·s × (rows·cellH + 2m)·s px, or at an exact
 * target width (rendered at the next integer scale and shrunk in linear light). The pixels are read
 * back asynchronously and encoded in a worker, so even a 12800 px export leaves the page responsive.
 * The file name comes from the grid that was rendered, captured in the same task as the render.
 */
export async function exportPng(engine: AsciiEngine, opts: PngExportOptions, signal?: AbortSignal): Promise<ExportResult> {
  const plan = planOutput(engine, opts);
  const pixels = await readPlanned(engine, plan, signal);
  const worker = new RasterWorker();
  try {
    const blob = await worker.png(pixels, plan.size, signal);
    return {
      blob,
      fileName: exportFileName(opts.sourceName ?? 'image', plan.grid, 'png'),
      width: plan.size.width,
      height: plan.size.height,
      warnings: [],
    };
  } finally {
    worker.terminate();
  }
}
