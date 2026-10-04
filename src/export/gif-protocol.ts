import type { Palette } from './gif-palette';

/** Messages between exportGif (main thread) and gif.worker.ts. */

export interface GifStartMessage {
  type: 'start';
  /** The GIF's size. */
  width: number;
  height: number;
  /** Size of the rasters sent; larger than the GIF when an exact width is resampled in the worker. */
  rasterWidth: number;
  rasterHeight: number;
  /** -1 = play once, 0 = loop forever, n = NETSCAPE repeat count. */
  loopCount: number;
  /** Fixed palette, or null to quantize one global palette from samples. */
  palette: Palette | null;
  paper: [number, number, number];
  /**
   * Adaptive palette when no 'sample' message arrived before the first frame (none were given, or
   * the source could not serve any): frames to buffer and sample before encoding starts.
   */
  bufferFrames: number;
}

export type GifRequest =
  | GifStartMessage
  /** RGBA raster used only to build the adaptive palette. */
  | { type: 'sample'; rgba: ArrayBuffer }
  | { type: 'frame'; rgba: ArrayBuffer; delayCs: number }
  | { type: 'finish' };

export type GifResponse =
  /** One per 'sample' / 'frame' message once the worker has taken it (main-thread backpressure). */
  | { type: 'ack' }
  | { type: 'encoded'; frames: number }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };
