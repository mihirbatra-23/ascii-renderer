/**
 * Browser canvas factory for the engine's Canvas2D work (glyph tiles, CPU rasters). Uses
 * OffscreenCanvas where available, so it also works inside workers.
 *
 * Public API
 *   browserCanvasFactory: CanvasFactory
 */
import type { CanvasFactory, GlyphContext } from './atlas';

export const browserCanvasFactory: CanvasFactory = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    return { canvas, ctx: ctx satisfies GlyphContext };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx: ctx satisfies GlyphContext };
};
