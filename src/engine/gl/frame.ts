/**
 * FrameSource plumbing (browser only).
 *
 * Public API
 *   frameSize(source)                 intrinsic pixel size of any FrameSource (0 × 0 if not ready)
 *   fittedSize(w, h, maxEdge)         the size fitFrame produces
 *   fitFrame(source, maxEdge)         the source itself, or a downscaled canvas copy when larger
 *   frameRgba(source, maxEdge?)       straight RGBA8 pixels via a 2D canvas → { rgba, width, height }
 *   createRasterCanvas(w, h)          OffscreenCanvas (or a DOM canvas) with a CPU-backed 2D context
 */
import type { FrameSource } from '../types';
import type { CpuImage } from '../cpu';

export function frameSize(source: FrameSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight };
  return { width: source.width, height: source.height };
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createRasterCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Context2D } {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Context2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

/** The size fitFrame produces: unchanged within `maxEdge`, else scaled down with the aspect kept. */
export function fittedSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const k = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Sources larger than `maxEdge` (e.g. the GPU's MAX_TEXTURE_SIZE) are redrawn smaller, aspect kept. */
export function fitFrame(source: FrameSource, maxEdge: number): FrameSource {
  const size = frameSize(source);
  const { width, height } = fittedSize(size.width, size.height, maxEdge);
  if (width === size.width && height === size.height) return source;
  const { canvas, ctx } = createRasterCanvas(width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

export function frameRgba(source: FrameSource, maxEdge = Infinity): CpuImage {
  const fitted = fitFrame(source, maxEdge);
  const { width, height } = frameSize(fitted);
  // A video without data yet, or a closed ImageBitmap / VideoFrame: nothing to read (as the GPU
  // upload treats it), rather than throwing from drawImage / getImageData.
  if (width === 0 || height === 0) return { rgba: new Uint8ClampedArray(0), width: 0, height: 0 };
  const { ctx } = createRasterCanvas(width, height);
  ctx.drawImage(fitted, 0, 0);
  return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}
