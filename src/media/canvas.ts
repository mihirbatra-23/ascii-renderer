/** Small OffscreenCanvas helpers shared by the browser-side loaders. */
import { hasTransparentPixel } from './rgba';

/** Long side of the downscaled copy scanned for transparency. */
const ALPHA_PROBE_SIDE = 512;

export function context2d(canvas: OffscreenCanvas, willReadFrequently = false): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
  return ctx;
}

/** A copy of `source` scaled down to at most `maxSide` px on its long side (never upscaled). */
export function scaledCopy(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  willReadFrequently = false,
): OffscreenCanvas {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = context2d(canvas, willReadFrequently);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Scans a downscaled copy rather than every pixel: cheap even at 100 MP, and transparency too
 * small to survive a 512 px downscale cannot affect an ASCII grid either.
 */
export function hasVisibleAlpha(source: CanvasImageSource, width: number, height: number): boolean {
  const probe = scaledCopy(source, width, height, ALPHA_PROBE_SIDE, true);
  return hasTransparentPixel(context2d(probe, true).getImageData(0, 0, probe.width, probe.height).data);
}
