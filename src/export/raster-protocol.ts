import type { PixelSize } from './geometry';
import type { Palette } from './gif-palette';

/** Messages between RasterWorker (raster-worker.ts) and raster.worker.ts. Pixels travel as transferred RGBA buffers. */

interface RasterInput {
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

export type RasterRequest =
  /** Encode as PNG, shrinking to `target` first when given. */
  | (RasterInput & { op: 'png'; target?: PixelSize })
  /** Shrink to `target` (linear-light area average). */
  | (RasterInput & { op: 'resize'; target: PixelSize })
  /** Measure the raster's cost as a PNG and as one full GIF frame (export size estimates). */
  | (RasterInput & { op: 'measure' })
  /**
   * Encode the raster and `next` (the following output frame, same size) as a GIF exactly as the
   * GIF worker does (fixed or adaptive palette, transparent-index delta) and report each frame's bytes.
   */
  | (RasterInput & { op: 'gifPair'; next: ArrayBuffer; palette: Palette | null; paper: [number, number, number] });

export type RasterReply =
  | { id: number; op: 'png'; blob: Blob }
  | { id: number; op: 'resize'; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; op: 'measure'; pngBytes: number; gifFrameBytes: number }
  | { id: number; op: 'gifPair'; firstBytes: number; deltaBytes: number }
  | { id: number; op: 'error'; message: string };
