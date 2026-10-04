/** Plumbing for raw RGBA rasters (RasterPixels): padding to a frame size and handing buffers to workers. */
import type { RasterPixels } from '../engine/types';
import type { PixelSize } from './geometry';

/** RGBA 0..255; alpha 0 means transparent padding. */
export type Rgba = readonly [number, number, number, number];

/**
 * A reusable frame of `size` whose rows beyond a smaller raster stay `fill` forever: the fill is
 * written once, and each place() only copies the raster's rows (video encoders need even sizes,
 * which are padded, never scaled).
 */
export class PaddedFrame {
  readonly data: Uint8ClampedArray<ArrayBuffer>;

  constructor(
    readonly size: PixelSize,
    fill: Rgba,
  ) {
    this.data = new Uint8ClampedArray(size.width * size.height * 4);
    new Uint32Array(this.data.buffer).fill(packRgba(fill));
  }

  /** Copies `raster` to the top-left corner and returns the whole frame. */
  place(raster: RasterPixels): Uint8ClampedArray<ArrayBuffer> {
    const { width, height } = this.size;
    if (raster.width > width || raster.height > height) {
      throw new RangeError(`A ${raster.width} × ${raster.height} raster does not fit a ${width} × ${height} frame.`);
    }
    const rowBytes = raster.width * 4;
    for (let y = 0; y < raster.height; y++) {
      this.data.set(raster.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * width * 4);
    }
    return this.data;
  }
}

/** One RGBA pixel as the little-endian uint32 a Uint32Array view of RGBA bytes reads it as. */
function packRgba([r, g, b, a]: Rgba): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * The pixel bytes as a standalone ArrayBuffer that can be transferred to a worker: the raster's own
 * buffer when it spans exactly the pixels (zero copy), otherwise a copy.
 */
export function transferableBytes(pixels: RasterPixels): ArrayBuffer {
  const { data } = pixels;
  const buffer = data.buffer;
  if (buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength) return buffer;
  return data.slice().buffer as ArrayBuffer;
}
