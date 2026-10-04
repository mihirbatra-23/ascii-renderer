/**
 * Stage geometry (design spec §2 "Frame sizing"), DOM-free.
 *
 *   StageBox                     the measured preview: .vp size, the art area inside it, DPR, fit padding
 *   computeLayout(box, grid, geometry, view, transparent) → StageLayout   grid rect in .vp CSS px + the
 *                                engine Viewport; 'fit' is the spec formula, snapped to a whole device-px
 *                                zoom when within 10%; `transparent` previews the export's dropped paper
 *   clampPan(box, gridW, gridH, zoom, panX, panY)   keeps part of the grid on screen
 *   sameLayout(a, b)             cheap equality, so overlays re-render only when something moved
 *   cellAt(layout, x, y)         the cell under a .vp point (null outside the visible grid)
 *   visibleGrid(layout)          the part of the grid inside the art area
 *
 * The engine places the grid itself (engine/gl/view.ts layoutView); the overlays use that same
 * function, so rulers, probe and split handle land on exactly the pixels the compose pass drew.
 */
import { layoutView } from '../../engine/gl/view';
import type { CellGeometry, GridSize, Viewport } from '../../engine/types';
import type { ViewState } from '../../state/store';
import { clamp } from '../kit';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageBox {
  /** The .vp element, CSS px. */
  width: number;
  height: number;
  /** Where the engine canvas sits inside .vp; the gutters around it hold rulers and caption. */
  area: Rect;
  dpr: number;
  /** Space kept around the grid when fitting (spec: 32 on desktop). */
  pad: number;
}

export interface StageLayout extends Rect {
  box: StageBox;
  cols: number;
  rows: number;
  /** Scale-1 output size of the grid, px (cols·cellW × rows·cellH). */
  outW: number;
  outH: number;
  /** CSS px per output px, as drawn. */
  zoom: number;
  fitZoom: number;
  fitted: boolean;
  /** One cell, CSS px. */
  cellW: number;
  cellH: number;
  viewport: Viewport;
}

/** At least this much of the grid stays inside the area while panning (CSS px). */
const KEEP_VISIBLE = 64;
/** 'fit' takes a whole device-px zoom when that costs at most this fraction (same rule as the engine). */
const FIT_SNAP = 0.1;

function fitZoom(box: StageBox, gridW: number, gridH: number): number {
  const fit = Math.max(0.01, Math.min((box.area.width - 2 * box.pad) / gridW, (box.area.height - 2 * box.pad) / gridH));
  const device = fit * box.dpr;
  const whole = Math.floor(device);
  return whole >= 1 && device < whole * (1 + FIT_SNAP) ? whole / box.dpr : fit;
}

export function clampPan(box: StageBox, gridW: number, gridH: number, zoom: number, panX: number, panY: number): { panX: number; panY: number } {
  const limit = (areaSize: number, gridSize: number) => Math.max(0, (areaSize + gridSize * zoom) / 2 - Math.min(KEEP_VISIBLE, gridSize * zoom));
  const lx = limit(box.area.width, gridW);
  const ly = limit(box.area.height, gridH);
  return { panX: clamp(panX, -lx, lx), panY: clamp(panY, -ly, ly) };
}

export function computeLayout(box: StageBox, grid: GridSize, geometry: CellGeometry, view: ViewState, transparent = false): StageLayout {
  const outW = grid.cols * geometry.cellW;
  const outH = grid.rows * geometry.cellH;
  const fit = fitZoom(box, outW, outH);
  const fitted = view.zoom === 'fit';
  const zoom = fitted ? fit : (view.zoom as number);
  const pan = fitted ? { panX: 0, panY: 0 } : clampPan(box, outW, outH, zoom, view.panX, view.panY);
  const viewport: Viewport = {
    width: box.area.width,
    height: box.area.height,
    devicePixelRatio: box.dpr,
    zoom,
    ...pan,
    compare: null,
    showSource: view.mode === 'source',
    transparentBackground: transparent,
  };
  const placed = layoutView(viewport, outW, outH);
  if (view.mode === 'split') {
    viewport.compare = (placed.originX + view.split * outW * placed.zoom) / placed.width;
    viewport.compareWith = view.compareWith;
  }
  const drawn = placed.zoom / box.dpr;
  return {
    box,
    cols: grid.cols,
    rows: grid.rows,
    outW,
    outH,
    zoom: drawn,
    fitZoom: fit,
    fitted,
    cellW: geometry.cellW * drawn,
    cellH: geometry.cellH * drawn,
    x: box.area.x + placed.originX / box.dpr,
    y: box.area.y + placed.originY / box.dpr,
    width: outW * drawn,
    height: outH * drawn,
    viewport,
  };
}

export function sameLayout(a: StageLayout | null, b: StageLayout | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.box === b.box &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.fitZoom === b.fitZoom &&
    a.fitted === b.fitted &&
    a.viewport.compare === b.viewport.compare &&
    a.viewport.compareWith === b.viewport.compareWith &&
    a.viewport.transparentBackground === b.viewport.transparentBackground
  );
}

/** The cell under a point in .vp coordinates, or null outside the grid. */
export function cellAt(layout: StageLayout, x: number, y: number): { col: number; row: number } | null {
  const { area } = layout.box;
  if (x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height) return null;
  const col = Math.floor((x - layout.x) / layout.cellW);
  const row = Math.floor((y - layout.y) / layout.cellH);
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
  return { col, row };
}

/** The part of the grid inside the art area (what is actually visible), .vp coordinates. */
export function visibleGrid(layout: StageLayout): Rect {
  const { area } = layout.box;
  const x0 = Math.max(layout.x, area.x);
  const y0 = Math.max(layout.y, area.y);
  const x1 = Math.min(layout.x + layout.width, area.x + area.width);
  const y1 = Math.min(layout.y + layout.height, area.y + area.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
