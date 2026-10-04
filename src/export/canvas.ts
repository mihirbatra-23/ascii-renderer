/** Canvas plumbing for the exporters (browser only). */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context2d(canvas: AnyCanvas, options?: CanvasRenderingContext2DSettings): Context2D {
  const ctx = canvas.getContext('2d', options) as Context2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}
