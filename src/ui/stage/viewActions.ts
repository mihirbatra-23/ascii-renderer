/**
 * Zoom and pan for the stage (header buttons, wheel / pinch, drag, shortcuts). Zoom is CSS px per
 * output px; 'fit' follows the stage size. Every change keeps the point under the cursor (or the
 * area centre) fixed and clamps the pan so part of the grid stays visible.
 *
 *   zoomTo(zoom, at?)     absolute zoom around a .vp point (default: the art area centre)
 *   zoomStep(dir, at?)    the next / previous ZOOM_STEPS value (buttons, keys: announced)
 *   zoomBy(factor, at?)   continuous (wheel, pinch); crossing 'fit' from above lands on 'fit'
 *   panBy(dx, dy)         drag; switches a fitted view to its numeric zoom first
 *   fitView()             zoom 'fit', pan reset (announced)
 *   actualSize()          zoom 100% (announced)
 *   zoomLimits(layout)    { min, max } for disabling the buttons
 *   formatZoom(zoom, scale)   '75%', '37.5%'
 */
import { getStageLayout } from '../../app/engineHost';
import { useStore } from '../../state/store';
import { clamp } from '../kit';
import { clampPan, type StageLayout } from './layout';

export const ZOOM_STEPS = [0.125, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;
const MAX_ZOOM = 16;
const EPS = 1e-3;

export function zoomLimits(layout: StageLayout): { min: number; max: number } {
  return { min: Math.min(layout.fitZoom, ZOOM_STEPS[0]), max: MAX_ZOOM };
}

function areaCentre(layout: StageLayout): { x: number; y: number } {
  const { area } = layout.box;
  return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
}

export function zoomTo(zoom: number, at?: { x: number; y: number }): number | null {
  const layout = getStageLayout();
  if (!layout) return null;
  const { min, max } = zoomLimits(layout);
  const next = clamp(zoom, min, max);
  const p = at ?? areaCentre(layout);
  // The output-px point under p stays under p.
  const u = (p.x - layout.x) / layout.zoom;
  const v = (p.y - layout.y) / layout.zoom;
  const { area } = layout.box;
  const panX = p.x - u * next - (area.x + (area.width - layout.outW * next) / 2);
  const panY = p.y - v * next - (area.y + (area.height - layout.outH * next) / 2);
  useStore.getState().setView({ zoom: next, ...clampPan(layout.box, layout.outW, layout.outH, next, panX, panY) });
  return next;
}

export function zoomStep(dir: 1 | -1, at?: { x: number; y: number }): void {
  const layout = getStageLayout();
  if (!layout) return;
  const z = layout.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * (1 + EPS)) : [...ZOOM_STEPS].reverse().find((s) => s < z * (1 - EPS));
  const { min, max } = zoomLimits(layout);
  const zoom = zoomTo(next ?? (dir > 0 ? max : min), at);
  // Wheel and pinch zoom continuously and stay quiet; a deliberate step says where it landed.
  if (zoom !== null) useStore.getState().announce(`Zoom ${formatZoom(zoom)}`);
}

export function zoomBy(factor: number, at?: { x: number; y: number }): void {
  const layout = getStageLayout();
  if (!layout) return;
  const next = layout.zoom * factor;
  if (factor < 1 && layout.zoom > layout.fitZoom * (1 + EPS) && next <= layout.fitZoom) return setFit();
  if (factor < 1 && layout.fitted) return;
  zoomTo(next, at);
}

export function panBy(dx: number, dy: number): void {
  const layout = getStageLayout();
  if (!layout) return;
  const { view, setView } = useStore.getState();
  const zoom = view.zoom === 'fit' ? layout.zoom : view.zoom;
  const panX = (view.zoom === 'fit' ? 0 : view.panX) + dx;
  const panY = (view.zoom === 'fit' ? 0 : view.panY) + dy;
  setView({ zoom, ...clampPan(layout.box, layout.outW, layout.outH, zoom, panX, panY) });
}

function setFit(): void {
  useStore.getState().setView({ zoom: 'fit', panX: 0, panY: 0 });
}

export function fitView(): void {
  setFit();
  useStore.getState().announce('Zoom to fit');
}

export function actualSize(): void {
  if (zoomTo(1) !== null) useStore.getState().announce('Zoom 100%');
}

/** Whole percentages, except halves that matter at small zooms ('37.5%'). */
export function formatZoom(zoom: number, scale = 1): string {
  const pct = (zoom * 100) / scale;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  const half = Math.round(pct * 2) / 2;
  return pct < 100 && Math.abs(half - pct) < 0.05 && !Number.isInteger(half) ? `${half}%` : `${Math.round(pct)}%`;
}
