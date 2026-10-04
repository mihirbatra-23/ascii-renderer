/**
 * AsciiEngine without WebGL2: the CPU reference analysis (src/engine/cpu.ts) and the Canvas2D
 * raster (src/engine/rasterCpu.ts). Slower (tens of ms per frame) but produces the same grid
 * and the same exact export sizes.
 *
 * Public API
 *   CpuEngine   implements RendererEngine (backend 'cpu')
 */
import type { CellProbe, GridSnapshot, RasterOptions, RasterPixels, RenderParams, RenderStats, Viewport } from '../types';
import { analyzeCpu, createHistory, toSnapshot, type CpuHistory, type CpuImage } from '../cpu';
import { rasterSize } from '../geometry';
import { renderRasterCpu } from '../rasterCpu';
import { browserCanvasFactory } from '../canvas';
import type { CanvasFactory } from '../atlas';
import { checkRaster, EngineBase } from './base';
import { createRasterCanvas, frameRgba } from './frame';
import { layoutView } from './view';

/**
 * Larger sources are downscaled before analysis to bound memory; the grid is still computed from
 * the full source size (as on the GPU and in the UI), and the analysis resamples to it.
 */
const MAX_SOURCE_EDGE = 4096;
/** Safe 2D-canvas edge across browsers. */
const MAX_CANVAS_EDGE = 16384;
/** Preview rasters are drawn at an integer scale ≥ the zoom, up to this. */
const MAX_PREVIEW_SCALE = 4;

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;

export class CpuEngine extends EngineBase {
  readonly backend = 'cpu' as const;
  readonly canvas: HTMLCanvasElement;
  readonly maxRasterSize = MAX_CANVAS_EDGE;
  private readonly ctx: CanvasRenderingContext2D;
  private image: CpuImage | null = null;
  private current: GridSnapshot | null = null;
  private history: CpuHistory | null = null;
  private preview: { scale: number; transparent: boolean; canvas: RasterCanvas } | null = null;
  /** The compare view's ramp render (and its own §8 history), while shown. */
  private compare: { snapshot: GridSnapshot | null; preview: { transparent: boolean; canvas: RasterCanvas } | null; history: CpuHistory | null } | null = null;
  /** readRaster draws into this canvas, reused while the size stays the same. */
  private readCanvas: ReturnType<typeof createRasterCanvas> | null = null;
  private lastMs = 0;

  constructor() {
    super();
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  protected glyphsChanged(): void {
    this.analysisChanged(true);
  }

  protected sourceChanged(): void {
    this.image = null;
  }

  protected analysisChanged(resetHistory: boolean): void {
    this.current = null;
    this.preview = null;
    if (this.compare) {
      this.compare.snapshot = null;
      this.compare.preview = null;
    }
    if (resetHistory) {
      this.history = null;
      if (this.compare) this.compare.history = null;
    }
  }

  protected sourceReleased(): void {
    this.image = null;
    this.compare = null;
    this.readCanvas = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  /** The grid of `params` over the current source (the render, or the compare view's ramp). */
  private analyseWith(params: RenderParams, history: CpuHistory | null): GridSnapshot | null {
    if (!this.glyphs || !this.info || !this.source) return null;
    this.image ??= frameRgba(this.source, MAX_SOURCE_EDGE);
    if (this.image.width === 0 || this.image.height === 0) return null;
    const { geometry, glyphSet, taps } = this.glyphs.setup;
    const result = analyzeCpu(this.image, params, this.levels, geometry, glyphSet, taps, {
      history: this.info.animated && history ? history : undefined,
      grid: this.getGrid(),
    });
    return toSnapshot(result, glyphSet, params, geometry);
  }

  private analyse(): GridSnapshot | null {
    if (this.current) return this.current;
    if (!this.params) return null;
    this.history ??= createHistory();
    this.current = this.analyseWith({ ...this.params }, this.history);
    return this.current;
  }

  private analyseCompare(): GridSnapshot | null {
    if (!this.params) return null;
    this.compare ??= { snapshot: null, preview: null, history: null };
    this.compare.history ??= createHistory();
    this.compare.snapshot ??= this.analyseWith({ ...this.params, mode: 'ramp', edges: false }, this.compare.history);
    return this.compare.snapshot;
  }

  render(viewport: Viewport): RenderStats {
    const t0 = performance.now();
    const grid = this.getGrid();
    if (!this.glyphs || grid.cols === 0) return { ...grid, ms: 0 };
    const { geometry } = this.glyphs.setup;
    const gridW = grid.cols * geometry.cellW;
    const gridH = grid.rows * geometry.cellH;
    const layout = layoutView(viewport, gridW, gridH);
    const { canvas, ctx } = this;
    if (canvas.width !== layout.width) canvas.width = layout.width;
    if (canvas.height !== layout.height) canvas.height = layout.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.clearRect(0, 0, layout.width, layout.height);
    const snapshot = this.analyse();
    if (!snapshot) return { ...grid, ms: (this.lastMs = performance.now() - t0) };

    let scale = layout.exact ? layout.zoom : Math.min(MAX_PREVIEW_SCALE, Math.max(1, Math.ceil(layout.zoom)));
    if (Math.max(gridW, gridH) * scale > MAX_CANVAS_EDGE) scale = 1;
    const transparent = viewport.transparentBackground ?? false;
    const raster = (s: GridSnapshot) => renderRasterCpu(s, { scale, margin: 0, transparentBackground: transparent }, browserCanvasFactory).canvas as RasterCanvas;
    if (this.preview?.scale !== scale || this.preview.transparent !== transparent) this.preview = { scale, transparent, canvas: raster(snapshot) };
    const w = gridW * layout.zoom;
    const h = gridH * layout.zoom;
    ctx.imageSmoothingEnabled = !layout.exact || layout.zoom !== scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.preview.canvas, layout.originX, layout.originY, w, h);
    if (layout.split !== null && this.source) {
      const rampSide = viewport.compareWith === 'ramp' && !viewport.showSource ? this.analyseCompare() : null;
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.originX, layout.originY, Math.max(0, Math.min(w, layout.split - layout.originX)), h);
      ctx.clip();
      if (rampSide && this.compare) {
        if (this.compare.preview?.transparent !== transparent) this.compare.preview = { transparent, canvas: raster(rampSide) };
        ctx.clearRect(layout.originX, layout.originY, w, h);
        ctx.drawImage(this.compare.preview.canvas, layout.originX, layout.originY, w, h);
      } else {
        ctx.clearRect(layout.originX, layout.originY, w, h);
        if (!transparent) {
          ctx.fillStyle = snapshot.params.paper;
          ctx.fillRect(layout.originX, layout.originY, w, h);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.source, layout.originX, layout.originY, w, h);
      }
      ctx.restore();
    }
    this.lastMs = performance.now() - t0;
    return { ...grid, ms: this.lastMs };
  }

  getTimings(): { gpuMs: number | null; cpuMs: number } {
    return { gpuMs: null, cpuMs: this.lastMs };
  }

  async warmup(): Promise<void> {
    // Nothing to compile.
  }

  snapshot(): GridSnapshot {
    this.requireReady();
    const snapshot = this.analyse();
    if (!snapshot) throw new Error('The source has no pixels yet (is the video loaded?).');
    return snapshot;
  }

  /** The analysis is computed on the CPU anyway, so the cell is read straight from the grid. */
  probe(col: number, row: number): CellProbe | null {
    const s = this.current;
    if (!s || !Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= s.cols || row >= s.rows) return null;
    const i = row * s.cols + col;
    return { col, row, char: s.chars[i], tone: s.tone[i] };
  }

  private checkedRaster(options: RasterOptions, factory: CanvasFactory): RasterCanvas {
    const { glyphs } = this.requireReady();
    const size = rasterSize(this.getGrid(), glyphs.setup.geometry, { scale: options.scale, margin: options.margin ?? 0 });
    checkRaster(options, size, this.maxRasterSize);
    return renderRasterCpu(this.snapshot(), options, factory).canvas as RasterCanvas;
  }

  renderRaster(options: RasterOptions): RasterCanvas {
    return this.checkedRaster(options, browserCanvasFactory);
  }

  async readRaster(options: RasterOptions): Promise<RasterPixels> {
    // One canvas, reused for every frame of the same size (motion exports), instead of one per call.
    const reuse: CanvasFactory = (width, height) => {
      const c = this.readCanvas;
      if (c && c.canvas.width === width && c.canvas.height === height) return c;
      this.readCanvas = createRasterCanvas(width, height);
      return this.readCanvas;
    };
    const canvas = this.checkedRaster(options, reuse);
    const { width, height } = canvas;
    const ctx = this.readCanvas!.ctx;
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  }

  dispose(): void {
    this.image = null;
    this.current = null;
    this.preview = null;
    this.compare = null;
    this.readCanvas = null;
    this.source = null;
  }
}
