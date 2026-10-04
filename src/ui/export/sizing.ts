/**
 * Export sizing (spec §7, "Export dimension truth"): the exact output size from the engine's
 * integer cell geometry, the aspect check computed from integers (never from a rounded label),
 * the whole scale a device can actually draw, and a custom width's exact size (resampled from the
 * next whole scale; height from the grid's aspect).
 *
 *   useExportPlan()   the plan the panel shows (and what the exporters will write); the stage's
 *                     dimension lines and the status bar can read the same numbers from it
 *   planExport(...)   the same, pure
 */
import { useMemo, useSyncExternalStore } from 'react';
import { runtime } from '../../app/runtime';
import { gridSize } from '../../engine';
import type { CellGeometry, GridSize, RenderParams } from '../../engine/types';
// The geometry module only: this file is in the first chunk (stage caption, status bar), the rest of
// src/export loads with the Export panel.
import { evenSize, gridPixelSize, maxScale, type PixelSize } from '../../export/geometry';
import { targetSize } from '../../export/output';
import type { ExportFormat } from '../../export/types';
import { NUMERIC_SPECS } from '../../state/params';
import { useStore, type ExportScale } from '../../state/store';

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  png: 'PNG',
  svg: 'SVG',
  txt: 'TXT',
  html: 'HTML',
  gif: 'GIF',
  mp4: 'MP4',
  webm: 'WebM',
};

/** The video codec each video format is written with. */
export const VIDEO_CODEC: Partial<Record<ExportFormat, string>> = { mp4: 'H.264', webm: 'VP9' };

export const MOTION_FORMATS: readonly ExportFormat[] = ['gif', 'mp4', 'webm'];
export const isMotion = (f: ExportFormat) => MOTION_FORMATS.includes(f);
/** Formats written at an integer raster scale (the others are 1× vector or text). */
export const isRaster = (f: ExportFormat) => f === 'png' || isMotion(f);
export const isVideo = (f: ExportFormat) => f === 'mp4' || f === 'webm';

/** Formats with an alpha channel (GIF has only 1-bit transparency, MP4 none). */
export const ALPHA_FORMATS: readonly ExportFormat[] = ['png', 'svg', 'webm'];

/**
 * Whether an export can drop the paper: an alpha format, and not Blocks in Source colour, which
 * paints both colours of every cell (ALGORITHM §7), so there is no paper to drop.
 */
export function canBeTransparent(format: ExportFormat, params: Pick<RenderParams, 'mode' | 'colorMode'>): boolean {
  return ALPHA_FORMATS.includes(format) && !(params.mode === 'blocks' && params.colorMode === 'source');
}

// ---------------------------------------------------------------- engine geometry

export interface EngineGeometry extends GridSize {
  geometry: CellGeometry;
  maxRasterSize: number;
}

let cachedGeometry: EngineGeometry | null = null;

function readGeometry(): EngineGeometry | null {
  const engine = runtime.get().engine;
  let next: EngineGeometry | null = null;
  try {
    if (engine) {
      const grid = engine.getGrid();
      if (grid.cols > 0 && grid.rows > 0) next = { ...grid, geometry: engine.getGeometry(), maxRasterSize: engine.maxRasterSize };
    }
  } catch {
    // Glyphs not built yet (setParams still loading the font).
  }
  const prev = cachedGeometry;
  const same =
    prev && next
      ? prev.cols === next.cols &&
        prev.rows === next.rows &&
        prev.maxRasterSize === next.maxRasterSize &&
        prev.geometry.cellW === next.geometry.cellW &&
        prev.geometry.cellH === next.geometry.cellH &&
        prev.geometry.fontSize === next.geometry.fontSize
      : prev === next;
  if (!same) cachedGeometry = next;
  return cachedGeometry;
}

function subscribeGeometry(onChange: () => void): () => void {
  // The engine has no events; any store change (params, stats after a render) may move it.
  const offStore = useStore.subscribe(onChange);
  const offRuntime = runtime.subscribe(onChange);
  return () => {
    offStore();
    offRuntime();
  };
}

/** The live grid and cell geometry; a new object only when one of them actually changes. */
function useEngineGeometry(): EngineGeometry | null {
  return useSyncExternalStore(subscribeGeometry, readGeometry);
}

// ---------------------------------------------------------------- plan

export type CheckKind = 'exact' | 'aspect' | 'warn' | 'text';

export interface ExportCheck {
  kind: CheckKind;
  text: string;
  /** Warning only: a column count whose rows round exactly, offered as a one-click fix. */
  fixColumns?: number;
}

/** The whole scales the picker offers. */
export const SCALE_STEPS = [1, 2, 4] as const;

export interface ExportPlan {
  format: ExportFormat;
  /**
   * Output px per scale-1 px: the whole scale written, or for a custom width the exact (possibly
   * fractional) ratio. 1 for vector and text formats.
   */
  scale: number;
  /** The whole scale the engine renders at (a custom width is resampled down from it). */
  renderScale: number;
  /** Largest whole scale this device can draw. */
  maxScale: number;
  /** The picked whole scale when the device cannot draw it, so a smaller one is used. */
  scaleTooLarge?: { scale: number; width: number; height: number };
  /** Custom width the file is resampled to (ExportOptions.targetWidth); absent for whole scales. */
  targetWidth?: number;
  grid: GridSize;
  /** Scale-1 size (cols·cellW × rows·cellH plus margins). */
  base: PixelSize;
  /** The size before video padding. */
  raster: PixelSize;
  /** The file's size: `raster`, padded to even numbers for video. */
  width: number;
  height: number;
  padded: boolean;
  /** Cell size in the file; fractional when a custom width resamples it. */
  cell: { width: number; height: number };
  glyphPx: number;
  source: PixelSize | null;
  check: ExportCheck;
}

export interface PlanInput {
  format: ExportFormat;
  /** Still (PNG) scale. */
  scale: ExportScale;
  /** GIF / MP4 / WebM scale. */
  motionScale: ExportScale;
  customWidth?: number;
  margin: number;
}

/** The scale setting that applies to a format: motion formats keep their own (default 1×). */
export function scaleSetting(input: Pick<PlanInput, 'scale' | 'motionScale'>, format: ExportFormat): ExportScale {
  return isMotion(format) ? input.motionScale : input.scale;
}

/** Narrowest custom width: one pixel per column. */
export function minCustomWidth(grid: GridSize, base: PixelSize): number {
  return Math.min(base.width, grid.cols);
}

/**
 * A custom width's file size: rendered at the next whole scale and resampled, the height following
 * the grid's aspect (ExportOptions.targetWidth). Clamped to what the device can render.
 */
export function customSize(width: number, base: PixelSize, grid: GridSize, max: number): PixelSize & { renderScale: number } {
  const clamped = Math.min(Math.max(width, minCustomWidth(grid, base)), base.width * Math.max(1, max));
  // The exporters' own rule (src/export/output.ts), so the panel shows exactly what they write.
  const { scale, size } = targetSize(base, clamped);
  return { ...size, renderScale: scale };
}

/**
 * The offered whole scale nearest to a custom width's ratio that the device can draw; halfway
 * between two, the larger, since a custom width was asked for to be larger than the smaller.
 */
export function nearestScale(plan: Pick<ExportPlan, 'scale' | 'maxScale'>): (typeof SCALE_STEPS)[number] {
  return SCALE_STEPS.filter((s) => s <= Math.max(1, plan.maxScale)).reduce((a, b) => (Math.abs(b - plan.scale) <= Math.abs(a - plan.scale) ? b : a));
}

/** The largest offered whole scale at or below `wanted` that the device can draw. */
function fittingScale(wanted: number, max: number): number {
  return [...SCALE_STEPS].reverse().find((s) => s <= wanted && s <= max) ?? 1;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** '16:9', '3:2'; '1.779:1' when the reduced ratio is not a readable pair. */
export function ratioLabel(w: number, h: number): string {
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  return a <= 64 && b <= 64 ? `${a}:${b}` : `${(w / h).toFixed(3)}:1`;
}

/** Nearest column count (within the Columns range) whose rounded rows reproduce the source aspect exactly. */
function exactColumns(src: PixelSize, cols: number, geometry: CellGeometry): number | undefined {
  const { min, max } = NUMERIC_SPECS.columns;
  for (let d = 1; d <= 60; d++) {
    for (const c of [cols - d, cols + d]) {
      if (c < min || c > max) continue;
      const g = gridSize(src.width, src.height, c, geometry);
      if (g.cols === c && c * geometry.cellW * src.height === g.rows * geometry.cellH * src.width) return c;
    }
  }
  return undefined;
}

function checkOf(format: ExportFormat, out: PixelSize, grid: GridSize, geometry: CellGeometry, src: PixelSize | null): ExportCheck {
  if (format === 'txt') {
    // Editors default to taller lines (often 1.5), which stretches the art: say which line height keeps it.
    const lineHeight = Number((geometry.cellH / geometry.fontSize).toFixed(2));
    return {
      kind: 'text',
      text: `One line per row, ${grid.cols} characters each. In a monospace editor, line height ${lineHeight} keeps this aspect.`,
    };
  }
  if (!src) return { kind: 'aspect', text: 'No crop, no squash: the grid’s own aspect, every cell the same size.' };
  const ratio = ratioLabel(src.width, src.height);
  const sameAspect = out.width * src.height === out.height * src.width;
  // A whole multiple of the source: every source pixel maps to a whole block of output pixels.
  if (sameAspect && out.width % src.width === 0) {
    return { kind: 'exact', text: `Matches source ${src.width} × ${src.height} exactly: ${ratio}, no crop, no squash.` };
  }
  if (sameAspect) {
    return { kind: 'aspect', text: `Same ${ratio} aspect as the source ${src.width} × ${src.height}: no crop, no squash.` };
  }
  const outAR = out.width / out.height;
  const srcAR = src.width / src.height;
  const d = (outAR / srcAR - 1) * 100;
  const sign = d > 0 ? '+' : '−';
  return {
    kind: 'warn',
    // Two decimals, like the stage caption, so both show the same delta.
    text: `Rows round to ${grid.rows}, so the aspect is ${outAR.toFixed(3)} against the source’s ${srcAR.toFixed(3)} (${sign}${Math.abs(d).toFixed(2)}%).`,
    fixColumns: exactColumns(src, grid.cols, geometry),
  };
}

export function planExport(input: PlanInput, geo: EngineGeometry, source: PixelSize | null): ExportPlan {
  const { format } = input;
  const { geometry } = geo;
  const grid = { cols: geo.cols, rows: geo.rows };
  const base = gridPixelSize(grid, geometry, input.margin);
  const max = maxScale(grid, geometry, input.margin, geo.maxRasterSize);
  const setting = scaleSetting(input, format);

  let raster: PixelSize = base;
  let renderScale = 1;
  let targetWidth: number | undefined;
  let scaleTooLarge: ExportPlan['scaleTooLarge'];
  if (isRaster(format) && setting === 'custom') {
    const size = customSize(input.customWidth ?? base.width, base, grid, max);
    raster = { width: size.width, height: size.height };
    renderScale = size.renderScale;
    // A width that is a whole scale needs no resampling: it is that scale, cells stay whole pixels.
    if (size.width !== base.width * renderScale) targetWidth = size.width;
  } else if (isRaster(format) && setting !== 'custom') {
    renderScale = fittingScale(setting, max);
    raster = { width: base.width * renderScale, height: base.height * renderScale };
    if (renderScale < setting) scaleTooLarge = { scale: setting, width: base.width * setting, height: base.height * setting };
  }
  const scale = raster.width / base.width;
  const file = isVideo(format) ? evenSize(raster) : raster;
  return {
    format,
    scale,
    renderScale,
    maxScale: max,
    scaleTooLarge,
    targetWidth,
    grid,
    base,
    raster,
    width: file.width,
    height: file.height,
    padded: file.width !== raster.width || file.height !== raster.height,
    cell: { width: geometry.cellW * scale, height: (geometry.cellH * raster.height) / base.height },
    glyphPx: geometry.fontSize * scale,
    source,
    check: checkOf(format, raster, grid, geometry, source),
  };
}

/** The export as currently configured, or null until the engine has a grid. */
export function useExportPlan(): ExportPlan | null {
  const geo = useEngineGeometry();
  const format = useStore((s) => s.exportUi.format);
  const scale = useStore((s) => s.exportUi.scale);
  const motionScale = useStore((s) => s.exportUi.motionScale);
  const customWidth = useStore((s) => s.exportUi.customWidth);
  const margin = useStore((s) => s.exportUi.margin);
  const srcW = useStore((s) => s.media.info?.width);
  const srcH = useStore((s) => s.media.info?.height);
  return useMemo(() => {
    if (!geo) return null;
    const source = srcW && srcH ? { width: srcW, height: srcH } : null;
    return planExport({ format, scale, motionScale, customWidth, margin }, geo, source);
  }, [geo, format, scale, motionScale, customWidth, margin, srcW, srcH]);
}

/** '2.1–3.4 MB' or '0.8–1.3 MB': both ends in the unit of the larger, so the range stays short. */
export function formatByteRange(low: number, high: number): string {
  const [hi, unit] = formatBytes(high).split(' ');
  const scale = unit === 'MB' ? 1e6 : unit === 'KB' ? 1e3 : 1;
  const decimals = unit === 'MB' && high < 1e7 ? 1 : 0;
  return `${(low / scale).toFixed(decimals)}–${hi} ${unit}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
