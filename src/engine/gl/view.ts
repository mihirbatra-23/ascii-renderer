/**
 * Preview layout (DOM-free): where the grid lands on the preview canvas for a Viewport.
 *
 * Public API
 *   ViewLayout                       canvas size, zoom, grid origin, compare split (device px)
 *   layoutView(viewport, gridW, gridH) → ViewLayout   (gridW/H: scale-1 output px, cols·cellW × rows·cellH)
 *   FIT_MARGIN_CSS, FIT_SNAP, MIN_ZOOM
 *
 * A zoom that is a whole number of device px per output px gives an integer origin and
 * `exact: true`: the compose pass then reads the atlas built at exactly that scale texel for
 * texel, so the preview is pixel-identical to an export at that scale. 'fit' snaps down to a
 * whole zoom when that costs less than FIT_SNAP of the size.
 */
import type { Viewport } from '../types';

export interface ViewLayout {
  /** Canvas backing size in device px. */
  width: number;
  height: number;
  /** Device px per output px. */
  zoom: number;
  /** Grid top-left in device px. */
  originX: number;
  originY: number;
  exact: boolean;
  /** Device-px x left of which the source is shown, or null (compare off, source hidden). */
  split: number | null;
}

/** Space kept around the grid in 'fit' (CSS px). */
export const FIT_MARGIN_CSS = 16;
/** 'fit' prefers a whole zoom when it is at most this fraction smaller than the exact fit. */
export const FIT_SNAP = 0.1;
/** Below this the blocks footprint filter would span more than 3 cells per axis. */
export const MIN_ZOOM = 1 / 16;

export function layoutView(viewport: Viewport, gridW: number, gridH: number): ViewLayout {
  const dpr = viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1;
  const width = Math.max(1, Math.round(viewport.width * dpr));
  const height = Math.max(1, Math.round(viewport.height * dpr));
  let zoom: number;
  let panX = 0;
  let panY = 0;
  if (viewport.zoom === 'fit') {
    const margin = FIT_MARGIN_CSS * dpr;
    const fit = Math.min((width - 2 * margin) / gridW, (height - 2 * margin) / gridH);
    const whole = Math.floor(fit);
    zoom = whole >= 1 && fit < whole * (1 + FIT_SNAP) ? whole : fit;
  } else {
    zoom = viewport.zoom * dpr;
    const rounded = Math.round(zoom);
    if (rounded >= 1 && Math.abs(zoom - rounded) < 1e-6) zoom = rounded;
    panX = viewport.panX * dpr;
    panY = viewport.panY * dpr;
  }
  zoom = Math.max(MIN_ZOOM, zoom);
  const exact = Number.isInteger(zoom);
  let originX = (width - gridW * zoom) / 2 + panX;
  let originY = (height - gridH * zoom) / 2 + panY;
  if (exact) {
    originX = Math.round(originX);
    originY = Math.round(originY);
  }
  let split: number | null = null;
  if (viewport.showSource) split = Infinity;
  else if (viewport.compare !== null) split = Math.min(1, Math.max(0, viewport.compare)) * width;
  return { width, height, zoom, originX, originY, exact, split };
}
