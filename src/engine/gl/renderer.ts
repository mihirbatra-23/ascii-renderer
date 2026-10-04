/**
 * The WebGL2 AsciiEngine (docs/ALGORITHM.md, docs/ARCHITECTURE.md "Engine").
 *
 *   pass 0  setSource uploads the frame (RGBA8, straight alpha); mipmaps are built only when a
 *           pass needs them (large reductions, the source shown minified in compare view)
 *   pass 1  analysis image, cols·SW × rows·SH: area-resampled tone (R32F, §3)
 *   pass 1b colour over the paper per block quadrant, 2·cols × 2·rows (RGBA32F), from the source
 *   pass 1c §5b edge layer only: difference of Gaussians of pass 1 (two separable passes)
 *   pass 2  one fragment per cell, MRT: (glyph index, tone, fg, bg) + §8 history features,
 *           ping-ponged so the previous frame's state is readable; a second set holds the compare
 *           view's ramp render
 *   pass 3  compose into the preview canvas (Viewport) or into export tiles at an exact scale; a
 *           preview below zoom 0.75 is composed at scale 1 and box-filtered onto the canvas
 *
 * Passes 1–2 run only when the source, params or levels changed; viewport changes only compose.
 * Glyph data (vectors, taps, atlases) is rebuilt only when the font, charset or line height change.
 *
 * Public API
 *   GlEngine.create(canvas?)   → GlEngine (throws when WebGL2 or float render targets are missing)
 *   GlEngine implements RendererEngine; diagnostics for dev/engine.html: glyphSetup(), readAnalysis(),
 *   analyseWithQuadColours(), readSourcePixels(), readPreview(viewport), profile(viewport), gpuInfo(),
 *   compiledPrograms(), allocations()
 */
import type { CellProbe, GridSnapshot, RasterOptions, RasterPixels, RenderParams, RenderStats, Viewport } from '../types';
import { analysisSize, rasterSize } from '../geometry';
import { toneConstants } from '../tone';
import { parseHexColor } from '../color';
import { cellCharOf, FIT_KEEP, THRESHOLD_KEEP, toSnapshot } from '../cpu';
import { EDGE_KEEP, edgeSetup } from '../edges';
import type { AnalysisSetup } from '../setup';
import { createFramebuffer, createTexture, TEX, type GL } from './gl';
import { composeKindOf, LIGHTNESS_MAX_FOOT, PRESENT_MAX_FOOT, PROGRAM_KEYS, QUADRANT_MAX_FOOT, specialisedCellKey, type ProgramKey } from './shaders';
import { GpuResources, type CellsKind } from './resources';
import { fenceAndWait } from './readback';
import { GpuTimer } from './timer';
import { layoutView, type ViewLayout } from './view';
import { createRasterCanvas } from './frame';
import { checkRaster, EngineBase } from './base';
import type { GlyphState } from './glyphs';

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

/** Export tiles: at most this many px per side and bytes per tile (bounds GPU memory per draw). */
const EXPORT_TILE_EDGE = 4096;
const EXPORT_TILE_BYTES = 32 << 20;
/** readRaster composes and queues the readback of this many bytes per batch before awaiting it. */
const READ_BATCH_BYTES = 64 << 20;
/**
 * Below this zoom (a canvas pixel spans more than 1.33 output px) the preview box-filters the 1×
 * export; above it the direct compose is already sharp and saves the extra pass.
 */
const MINIFY_BELOW = 0.75;

const COLOR_MODES = { mono: 0, source: 1, duotone: 2 } as const;
const HALFTONE_SHAPES = { round: 0, square: 1, diamond: 2, line: 3 } as const;
const PATTERNS = { none: 0, ordered: 1, noise: 2 } as const;

/** Where and how pass 3 draws. */
interface ComposeTarget {
  zoom: number;
  originX: number;
  originY: number;
  exact: boolean;
  /** Device px added to gl_FragCoord (export tile origin; preview: (0, canvas height) with flipY). */
  fragX: number;
  fragY: number;
  flipY: boolean;
  outsideClear: boolean;
  transparent: boolean;
  premultiply: boolean;
  /** x left of which the source is shown, or null. */
  split: number | null;
}

/** Which analysed grid pass 3 draws: the render, or the compare view's ramp render. */
interface ComposeLayer {
  cells: CellsKind;
  mode: RenderParams['mode'];
}

/**
 * Everything pass 3 reads for one layer: the live render (liveLayer), or a copy fixed at one moment
 * (freezeLayer), from which readRaster composes every batch of a large export, so edits, new video
 * frames or a closed file between batches cannot mix two pictures.
 */
interface LayerState {
  mode: RenderParams['mode'];
  params: RenderParams;
  glyphs: GlyphState;
  cols: number;
  rows: number;
  /** The cell texture: the live set's, or a copy owned by the export (deleted when it ends). */
  cell: WebGLTexture;
}

export interface AnalysisReadback {
  width: number;
  height: number;
  /** Tone-mapped lightness per analysis pixel. */
  lightness: Float32Array;
  quadWidth: number;
  quadHeight: number;
  /** RGBA colour over the paper per block quadrant (2·cols × 2·rows). */
  quadColours: Float32Array;
}

export interface FrameProfile {
  analysisMs: number;
  composeMs: number;
  totalMs: number;
}

interface ProbeData {
  generation: number;
  cols: number;
  rows: number;
  /** The cell texture: (glyph index, tone, fg, bg) per cell. */
  cells: Float32Array;
  charOf: (index: number) => string;
}

/** An export's exact size and tile plan. */
interface RasterPlan {
  width: number;
  height: number;
  scale: number;
  margin: number;
  tileW: number;
  tileH: number;
}

/** Atlas scale for the filtered (mipmapped) preview path: at least the zoom, a power of two in [4, 16]. */
function filteredAtlasScale(zoom: number): number {
  return Math.min(16, Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(zoom, 1)))));
}

/** Integer canvas columns whose pixel centres lie left of `split` (a fragment at x has its centre at x + 0.5). */
function columnsLeftOf(split: number, width: number): number {
  return Math.min(width, Math.max(0, Math.ceil(split - 0.5)));
}

export class GlEngine extends EngineBase {
  readonly backend = 'webgl2' as const;
  readonly maxRasterSize: number;
  private gpu: GpuResources | null;
  private timer: GpuTimer | null;
  private sourceReady = false;
  private analysed = false;
  private historyStale = true;
  /** The compare view's ramp render: stale after every analysis; its own §8 history. */
  private compareStale = true;
  private compareHistoryStale = true;
  private wantCompare = false;
  /** Counts pass-2 runs of the render (keys the probe cache). */
  private generation = 0;
  private probeData: ProbeData | null = null;
  private probeReading = false;
  private lastCpuMs = 0;
  /** Diagnostics: false keeps pass 2 on the uniform-driven programs (both must give the same grid). */
  specialisedPrograms = true;
  private readonly onLost = (e: Event) => {
    e.preventDefault();
    this.gpu = null;
    this.timer = null;
    this.analysed = false;
    this.probeData = null;
  };
  private readonly onRestored = () => this.restore();

  static create(canvas: HTMLCanvasElement = document.createElement('canvas')): GlEngine {
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    if (!gl) throw new Error('WebGL2 is not available.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float render targets (EXT_color_buffer_float) are not available.');
    return new GlEngine(canvas, gl);
  }

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: GL,
  ) {
    super();
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxRasterSize = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      dims[0],
      dims[1],
    );
    this.gpu = new GpuResources(gl, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.timer = new GpuTimer(gl);
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  private restore(): void {
    const { gl } = this;
    gl.getExtension('EXT_color_buffer_float');
    this.gpu = new GpuResources(gl, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.timer = new GpuTimer(gl);
    if (this.glyphs) this.gpu.setGlyphData(this.glyphs);
    this.sourceReady = false;
    this.sourceChanged();
    this.analysisChanged(true);
  }

  protected glyphsChanged(): void {
    if (this.glyphs) this.gpu?.setGlyphData(this.glyphs);
    this.analysisChanged(true);
  }

  protected sourceChanged(): void {
    if (!this.gpu || !this.source) return;
    try {
      this.sourceReady = this.gpu.uploadSource(this.source);
    } catch (e) {
      // A closed ImageBitmap / VideoFrame cannot be re-uploaded after a context restore.
      if (!this.gl.isContextLost()) throw e;
      this.sourceReady = false;
    }
  }

  protected analysisChanged(resetHistory: boolean): void {
    this.analysed = false;
    this.compareStale = true;
    if (resetHistory) {
      this.historyStale = true;
      this.compareHistoryStale = true;
    }
  }

  protected sourceReleased(): void {
    this.sourceReady = false;
    this.probeData = null;
    this.gpu?.releaseSourceMemory();
    // The preview canvas's drawing buffers are as large as the stage; give them back too.
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  private requireGpu(): GpuResources {
    if (!this.gpu) throw new Error('The WebGL context was lost; rendering resumes when the browser restores it.');
    return this.gpu;
  }

  /** Passes 1–2 (and the compare render when shown), when anything they depend on changed. False while there is nothing to analyse. */
  private analyse(): boolean {
    const gpu = this.gpu;
    if (!gpu || !this.params || !this.glyphs || !this.info || !this.sourceReady || !gpu.glyphData) return false;
    const { setup } = this.glyphs;
    const grid = this.getGrid();
    const animated = this.info.animated;
    if (!this.analysed) {
      const size = analysisSize(grid, setup.geometry);
      gpu.ensureAnalysis(grid, size.width, size.height);
      if (gpu.ensureCells('main', grid.cols, grid.rows)) this.historyStale = true;
      if (this.historyStale) {
        gpu.clearHistory('main');
        this.historyStale = false;
      }
      this.runAnalysisImage(gpu, this.params);
      if (this.edgesOn(this.params)) this.runEdges(gpu);
      else gpu.deleteEdges();
      this.runCells(gpu, 'main', this.params, setup, animated);
      this.generation++;
      this.analysed = true;
    }
    if (this.wantCompare && this.compareStale) {
      if (gpu.ensureCells('compare', grid.cols, grid.rows)) this.compareHistoryStale = true;
      if (this.compareHistoryStale) {
        gpu.clearHistory('compare');
        this.compareHistoryStale = false;
      }
      this.runCells(gpu, 'compare', this.compareParams(this.params), setup, animated);
      this.compareStale = false;
    }
    return true;
  }

  private edgesOn(params: RenderParams): boolean {
    return params.edges && (params.mode === 'shape' || params.mode === 'ramp');
  }

  /** The compare view's left side: the same picture as a plain density ramp. */
  private compareParams(params: RenderParams): RenderParams {
    return { ...params, mode: 'ramp', edges: false };
  }

  /** Pass 1 (tone at analysis resolution) and pass 1b (quadrant colours), both from the source. */
  private runAnalysisImage(gpu: GpuResources, params: RenderParams): void {
    const { gl } = this;
    const a = gpu.analysis!;
    const tone = toneConstants(params, this.levels);
    // Mip levels are read only when a target pixel's footprint exceeds the resampler's budget.
    const src = gpu.sourceSize;
    const reduction = (w: number, h: number) => Math.max(src.width / w, src.height / h);
    const levelsFor = (w: number, h: number, maxFoot: number) => (reduction(w, h) > maxFoot ? gpu.ensureSourceMips() : 0);
    gl.bindVertexArray(gpu.vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.viewport(0, 0, a.width, a.height);
    gpu
      .program('lightness')
      .use()
      .texture('uSrc', 0, gpu.source)
      .ivec2('uDst', a.width, a.height)
      .int('uMaxLevel', levelsFor(a.width, a.height, LIGHTNESS_MAX_FOOT))
      .float('uBlack', tone.black)
      .float('uScale', tone.scale)
      .float('uContrast', tone.contrast)
      .float('uBrightness', tone.brightness)
      .float('uGamma', tone.gamma)
      .int('uInvert', tone.invert);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, a.quadFbo);
    gl.viewport(0, 0, a.quadWidth, a.quadHeight);
    gpu
      .program('quadrants')
      .use()
      .texture('uSrc', 0, gpu.source)
      .ivec2('uDst', a.quadWidth, a.quadHeight)
      .int('uMaxLevel', levelsFor(a.quadWidth, a.quadHeight, QUADRANT_MAX_FOOT))
      .vec3('uPaper', unit(parseHexColor(params.paper)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Pass 1c (§5b): the difference of Gaussians of the analysis image. */
  private runEdges(gpu: GpuResources): void {
    const { gl } = this;
    const a = gpu.analysis!;
    const e = gpu.ensureEdges(a.width, a.height);
    gl.bindVertexArray(gpu.vao);
    gl.viewport(0, 0, a.width, a.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, e.blurFbo);
    gpu.program('edge-blur').use().texture('uL', 0, a.lightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, e.dogFbo);
    gpu.program('edge-dog').use().texture('uBlur', 0, e.blur);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Pass 2: per-cell analysis from the analysis image into the other ping-pong set. */
  private runCells(gpu: GpuResources, which: CellsKind, params: RenderParams, setup: AnalysisSetup, history: boolean): void {
    const { gl } = this;
    const a = gpu.analysis!;
    const cells = gpu.cellsOf(which)!;
    const glyphs = gpu.glyphData!;
    const { glyphSet, taps } = setup;
    const prev = cells.sets[cells.current];
    const next = cells.sets[1 - cells.current];
    gl.bindVertexArray(gpu.vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
    gl.viewport(0, 0, cells.cols, cells.rows);
    const stability = history ? params.stability : 0;
    // The program specialised for this geometry once its background compile is done; until then
    // (and for the first frames after a font or line-height change) the uniform-driven one.
    const special = this.specialisedPrograms ? gpu.readyProgram(specialisedCellKey(params.mode, taps.sw, taps.sh)) : null;
    const program = (special ?? gpu.program(`cell:${params.mode}`))
      .use()
      .texture('uL', 0, a.lightness)
      .texture('uQuads', 1, a.quads)
      .texture('uNoise', 2, gpu.noise)
      .texture('uPrevCell', 3, prev.cell)
      .texture('uPrevA', 4, prev.histA)
      .texture('uPrevB', 5, prev.histB)
      .block('Glyphs', 0, glyphs.ubo)
      .block('Taps', 1, glyphs.taps)
      .ivec2('uImage', a.width, a.height)
      .int('uSW', taps.sw)
      .int('uSH', taps.sh)
      .int('uGlyphCount', glyphs.count)
      // Ramp's white point is its own darkest candidate's coverage (GlyphSet.rampAnchor).
      .float('uAnchor', params.mode === 'ramp' ? glyphSet.rampAnchor : glyphSet.anchor)
      .float('uGlobal', params.shapeSharpness)
      .float('uDirectional', params.edgeSharpness)
      .float('uDither', params.dither)
      .float('uStability', params.stability)
      .int('uHistory', history)
      .float('uBand', stability * THRESHOLD_KEEP)
      .float('uFitBand', stability * FIT_KEEP)
      .int('uPattern', PATTERNS[params.ditherPattern])
      .int('uBlocksColour', params.mode === 'blocks' && params.colorMode === 'source');
    if (params.mode === 'shape' || params.mode === 'ramp') {
      const edges = this.edgesOn(params) ? gpu.edges : null;
      const e = edgeSetup(taps.sw, taps.sh, glyphSet.lowStrokeSplit, params.edgeThreshold);
      program
        .int('uEdges', !!edges)
        // Bound in either case so the sampler always has a texture of its type.
        .texture('uDoG', 6, edges ? edges.dog : a.lightness)
        .float('uTanSteep', e.tanSteep)
        .float('uTanFlat', e.tanFlat)
        .vec4('uEdgeNorm', e.norm)
        .float('uLowSplit', e.lowSplit * e.sh)
        .float('uEdgeThreshold', e.threshold)
        .float('uEdgeBand', stability * EDGE_KEEP)
        .ints('uStrokes', Int32Array.from(glyphSet.strokes));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    cells.current = cells.current === 0 ? 1 : 0;
  }

  /** Pass 3 into whatever framebuffer and viewport are bound. */
  private compose(t: ComposeTarget, layer: ComposeLayer | LayerState = { cells: 'main', mode: this.params!.mode }): void {
    const gpu = this.requireGpu();
    const { gl } = this;
    const state = 'cell' in layer ? layer : this.liveLayer(gpu, layer);
    const { params } = state;
    const { geometry, glyphSet } = state.glyphs.setup;
    const { pad } = state.glyphs;
    const kind = composeKindOf(layer.mode);
    const blocksColour = layer.mode === 'blocks' && params.colorMode === 'source';
    const program = gpu.program(`compose:${kind}`).use();
    // The source is shown (compare / showSource) with trilinear filtering when it is minified.
    if (t.split !== null && t.zoom * state.cols * geometry.cellW < gpu.sourceSize.width) gpu.ensureSourceMips();
    gl.bindVertexArray(gpu.vao);
    gl.disable(gl.BLEND);
    program.texture('uCells', 0, state.cell).texture('uSrc', 2, gpu.source);
    if (kind === 'text') {
      const scale = t.exact ? t.zoom : filteredAtlasScale(t.zoom);
      const atlas = gpu.atlas(scale, glyphSet.atlasChars, geometry, pad);
      const paddedW = geometry.cellW + 2 * pad.x;
      const paddedH = geometry.cellH + 2 * pad.y;
      program
        .texture('uAtlas', 1, atlas.texture, gl.TEXTURE_2D_ARRAY)
        .int('uExact', t.exact)
        .ivec2('uPad', pad.x, pad.y)
        .ivec2('uReach', pad.x > 0 ? 1 : 0, pad.y > 0 ? 1 : 0)
        .ivec2('uTile', atlas.tileW, atlas.tileH)
        .vec2('uGrad', 1 / (t.zoom * paddedW), 1 / (t.zoom * paddedH));
    }
    const angle = (params.halftoneAngle * Math.PI) / 180;
    const axis = params.halftoneShape === 'diamond' ? angle + Math.PI / 4 : angle;
    program
      .ivec2('uGrid', state.cols, state.rows)
      .vec2('uCellSize', geometry.cellW, geometry.cellH)
      .vec2('uOrigin', t.originX, t.originY)
      .float('uZoom', t.zoom)
      .vec2('uFragOffset', t.fragX, t.fragY)
      .int('uFlipY', t.flipY)
      .int('uOutsideClear', t.outsideClear)
      .int('uTransparent', t.transparent)
      .int('uPremultiply', t.premultiply)
      .int('uColorMode', COLOR_MODES[params.colorMode])
      .vec3('uInk', parseHexColor(params.ink))
      .vec3('uPaper', parseHexColor(params.paper))
      .vec3('uShadow', parseHexColor(params.shadowInk))
      .float('uSplit', t.split === null ? -1 : Math.min(t.split, 1e9))
      .int('uBlocksColour', blocksColour)
      .vec2('uBlockSplit', Math.round(geometry.cellW / 2), Math.round(geometry.cellH / 2))
      .vec2('uHtDir', Math.cos(angle), Math.sin(angle))
      .vec2('uHtAxis', Math.cos(axis), Math.sin(axis))
      .int('uHtShape', HALFTONE_SHAPES[params.halftoneShape]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The analysed grid `layer` names, as it is now. */
  private liveLayer(gpu: GpuResources, layer: ComposeLayer): LayerState {
    const cells = gpu.cellsOf(layer.cells)!;
    const { cols, rows } = cells;
    return { mode: layer.mode, params: this.params!, glyphs: this.glyphs!, cols, rows, cell: cells.sets[cells.current].cell };
  }

  /** The render as it is now, with its own copy of the cell texture (see LayerState). */
  private freezeLayer(gpu: GpuResources): LayerState {
    const { gl } = this;
    const cells = gpu.cells!;
    const { cols, rows } = cells;
    const cell = createTexture(gl, cols, rows, TEX.RGBA32F);
    const copy = createFramebuffer(gl, [cell]);
    // The set's framebuffer has the cell texture at attachment 0; a blit copies it on the GPU.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cells.sets[cells.current].fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, copy);
    gl.blitFramebuffer(0, 0, cols, rows, 0, 0, cols, rows, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.deleteFramebuffer(copy);
    const params = this.params!;
    return { mode: params.mode, params: { ...params }, glyphs: this.glyphs!, cols, rows, cell };
  }

  /** Draws `layer` only into the canvas / target columns [0, columns). */
  private composeScissored(t: ComposeTarget, layer: ComposeLayer, columns: number, height: number): void {
    if (columns <= 0) return;
    const { gl } = this;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, columns, height);
    try {
      this.compose(t, layer);
    } finally {
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  private composePreview(layout: ViewLayout, transparent: boolean): void {
    const { gl, canvas } = this;
    // Compare with ramp: the render everywhere, then the ramp render left of the split.
    const compareRamp = this.wantCompare && layout.split !== null;
    const ramp: ComposeLayer = { cells: 'compare', mode: 'ramp' };
    if (layout.zoom < MINIFY_BELOW) {
      this.composeMinified(layout, compareRamp ? ramp : null, transparent);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layout.width, layout.height);
    const target: ComposeTarget = {
      zoom: layout.zoom,
      originX: layout.originX,
      originY: layout.originY,
      exact: layout.exact,
      fragX: 0,
      fragY: canvas.height,
      flipY: true,
      outsideClear: true,
      transparent,
      premultiply: true,
      split: compareRamp ? null : layout.split,
    };
    this.compose(target);
    if (compareRamp) this.composeScissored(target, ramp, columnsLeftOf(layout.split!, layout.width), layout.height);
  }

  /**
   * Zoom < MINIFY_BELOW: the grid is composed at scale 1 (the 1× export, exact glyphs) into an
   * offscreen raster, which the present pass box-filters onto the canvas: every canvas pixel is the
   * area average of the export under it, so small glyphs stay legible (trilinear sampling of the
   * 4× atlas blurred them into row bands) and halftone screens do not beat against the pixel grid.
   */
  private composeMinified(layout: ViewLayout, ramp: ComposeLayer | null, transparent: boolean): void {
    const gpu = this.requireGpu();
    const { gl, canvas } = this;
    const { geometry } = this.glyphs!.setup;
    const cells = gpu.cells!;
    const width = cells.cols * geometry.cellW;
    const height = cells.rows * geometry.cellH;
    const raster = gpu.previewRaster(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, raster.fbo);
    gl.viewport(0, 0, width, height);
    const exact: ComposeTarget = {
      zoom: 1,
      originX: 0,
      originY: 0,
      exact: true,
      fragX: 0,
      fragY: 0,
      flipY: false,
      outsideClear: false,
      transparent,
      premultiply: true,
      split: null,
    };
    this.compose(exact);
    if (ramp) this.composeScissored(exact, ramp, columnsLeftOf((layout.split! - layout.originX) / layout.zoom, width), height);

    // Mip levels keep each canvas pixel's footprint within PRESENT_MAX_FOOT raster texels.
    let maxLevel = 0;
    gl.bindTexture(gl.TEXTURE_2D, raster.texture);
    if (1 / layout.zoom > PRESENT_MAX_FOOT) {
      maxLevel = Math.floor(Math.log2(Math.max(width, height)));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    const split = ramp ? null : layout.split;
    if (split !== null && layout.zoom * width < gpu.sourceSize.width) gpu.ensureSourceMips();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layout.width, layout.height);
    gl.bindVertexArray(gpu.vao);
    gpu
      .program('present')
      .use()
      .texture('uRaster', 0, raster.texture)
      .texture('uSrc', 2, gpu.source)
      .int('uMaxLevel', maxLevel)
      .ivec2('uGrid', cells.cols, cells.rows)
      .vec2('uCellSize', geometry.cellW, geometry.cellH)
      .vec2('uOrigin', layout.originX, layout.originY)
      .float('uZoom', layout.zoom)
      .vec2('uFragOffset', 0, canvas.height)
      .int('uFlipY', true)
      .int('uTransparent', transparent)
      .vec3('uPaper', parseHexColor(this.params!.paper))
      .float('uSplit', split === null ? -1 : Math.min(split, 1e9));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private sizeCanvas(viewport: Viewport, layout: ViewLayout): void {
    const { canvas } = this;
    if (canvas.width !== layout.width) canvas.width = layout.width;
    if (canvas.height !== layout.height) canvas.height = layout.height;
    const w = `${viewport.width}px`;
    const h = `${viewport.height}px`;
    if (canvas.style.width !== w) canvas.style.width = w;
    if (canvas.style.height !== h) canvas.style.height = h;
  }

  private clearPreview(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(viewport: Viewport): RenderStats {
    const t0 = performance.now();
    const grid = this.getGrid();
    if (!this.gpu || grid.cols === 0) return { ...grid, ms: 0 };
    const wantCompare = viewport.compareWith === 'ramp' && viewport.compare !== null && !viewport.showSource;
    if (wantCompare && !this.wantCompare) this.compareHistoryStale = true;
    this.wantCompare = wantCompare;
    const { geometry } = this.glyphs!.setup;
    const layout = layoutView(viewport, grid.cols * geometry.cellW, grid.rows * geometry.cellH);
    this.sizeCanvas(viewport, layout);
    // Passes 1–2 run in this frame unless the grid is current (a view-only redraw composes only).
    this.timer?.begin(!this.analysed || (wantCompare && this.compareStale));
    try {
      if (this.analyse()) this.composePreview(layout, viewport.transparentBackground ?? false);
      else this.clearPreview();
    } finally {
      this.timer?.end();
    }
    this.lastCpuMs = performance.now() - t0;
    return { ...grid, ms: this.lastCpuMs };
  }

  getTimings(): { gpuMs: number | null; cpuMs: number; gpuSamples?: number[] } {
    const gpuSamples = this.timer?.drain();
    return { gpuMs: this.timer?.latestMs ?? null, cpuMs: this.lastCpuMs, gpuSamples };
  }

  /**
   * Every geometry-independent program, plus pass 2 specialised for the current geometry when known.
   * The current mode's first-draw programs are issued first, so when warmup runs while a file is
   * still decoding, the first draw finds them compiled (or nearly) instead of compiling them itself.
   */
  async warmup(): Promise<void> {
    const gpu = this.gpu;
    if (!gpu) return;
    const mode = this.params?.mode ?? 'shape';
    const first: ProgramKey[] = ['lightness', 'quadrants', `cell:${mode}`, `compose:${composeKindOf(mode)}`];
    const keys: ProgramKey[] = [...first, ...PROGRAM_KEYS.filter((k) => !first.includes(k))];
    const taps = this.glyphs?.setup.taps;
    if (taps && this.specialisedPrograms) {
      for (const mode of ['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const) keys.push(specialisedCellKey(mode, taps.sw, taps.sh));
    }
    await gpu.warmup(keys, () => this.gpu === gpu && !this.gl.isContextLost());
  }

  snapshot(): GridSnapshot {
    const gpu = this.requireGpu();
    this.requireReady();
    if (!this.analyse()) throw new Error('The source has no pixels yet (is the video loaded?).');
    return this.readSnapshot(gpu);
  }

  private readSnapshot(gpu: GpuResources): GridSnapshot {
    const params = this.params!;
    const { setup } = this.glyphs!;
    const cells = gpu.cells!;
    const n = cells.cols * cells.rows;
    const data = gpu.readTexture(cells.sets[cells.current].cell, cells.cols, cells.rows, true);
    const indices = new Uint16Array(n);
    const tone = new Float32Array(n);
    const colors = new Uint8Array(n * 3);
    const backgrounds = params.mode === 'blocks' && params.colorMode === 'source' ? new Uint8Array(n * 3) : undefined;
    const unpack = (v: number, out: Uint8Array, o: number) => {
      out[o] = (v >>> 16) & 255;
      out[o + 1] = (v >>> 8) & 255;
      out[o + 2] = v & 255;
    };
    for (let i = 0; i < n; i++) {
      indices[i] = data[i * 4];
      tone[i] = data[i * 4 + 1];
      unpack(data[i * 4 + 2], colors, i * 3);
      if (backgrounds) unpack(data[i * 4 + 3], backgrounds, i * 3);
    }
    const result = { grid: { cols: cells.cols, rows: cells.rows }, indices, tone, colors, backgrounds };
    return toSnapshot(result, setup.glyphSet, { ...params }, setup.geometry);
  }

  /**
   * Answers from the last cell texture read back; when a newer analysis exists it starts reading
   * that one asynchronously and meanwhile answers from the older data, marked `pending`.
   */
  probe(col: number, row: number): CellProbe | null {
    const gpu = this.gpu;
    if (!gpu) return null;
    // Until the next render re-analyses, the newest data is the last analysed frame's (pending).
    const fresh = this.analysed && this.probeData?.generation === this.generation;
    if (this.analysed && !fresh && gpu.cells) this.readProbeData(gpu);
    const data = this.probeData;
    if (!data || !Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= data.cols || row >= data.rows) return null;
    const i = (row * data.cols + col) * 4;
    const probe: CellProbe = { col, row, char: data.charOf(data.cells[i]), tone: data.cells[i + 1] };
    if (!fresh) probe.pending = true;
    return probe;
  }

  private readProbeData(gpu: GpuResources): void {
    if (this.probeReading) return;
    const { gl } = this;
    const cells = gpu.cells!;
    const generation = this.generation;
    const { cols, rows } = cells;
    const charOf = cellCharOf(this.params!.mode, this.glyphs!.setup.glyphSet);
    const bytes = cols * rows * 16;
    const buffer = gpu.packBuffers.acquire(bytes);
    // The set's own framebuffer has the cell texture at attachment 0 (no per-read framebuffer).
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cells.sets[cells.current].fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.probeReading = true;
    void fenceAndWait(gl)
      .then(() => {
        // Lost context, or the grid was freed (file closed) or reallocated meanwhile: the data is stale.
        if (this.gpu !== gpu || gpu.cells !== cells) return;
        const reuse = this.probeData?.cells.length === cols * rows * 4 ? this.probeData.cells : null;
        const out = reuse ?? new Float32Array(cols * rows * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, out.length);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.probeData = { generation, cols, rows, cells: out, charOf };
      })
      .catch(() => {
        // Context lost: the probe answers null until the next analysis.
      })
      .finally(() => {
        this.probeReading = false;
        if (this.gpu === gpu) gpu.packBuffers.release(buffer);
      });
  }

  /** Validates options, runs the analysis and returns the exact size and tile plan. */
  private rasterPlan(options: RasterOptions): RasterPlan {
    this.requireGpu();
    const { glyphs } = this.requireReady();
    const size = rasterSize(this.getGrid(), glyphs.setup.geometry, { scale: options.scale, margin: options.margin ?? 0 });
    const { scale, margin } = checkRaster(options, size, this.maxRasterSize);
    if (!this.analyse()) throw new Error('The source has no pixels yet (is the video loaded?).');
    const tileW = Math.min(size.width, EXPORT_TILE_EDGE, this.maxRasterSize);
    const tileH = Math.min(size.height, EXPORT_TILE_EDGE, this.maxRasterSize, Math.max(1, Math.floor(EXPORT_TILE_BYTES / (tileW * 4))));
    return { ...size, scale, margin, tileW, tileH };
  }

  /**
   * Composes rows [y0, y0 + rows) of the export at an exact scale, tile by tile, calling `read`
   * after each tile with the tile's export position and size (the tile's pixels are in the bound
   * framebuffer's bottom-left tw × th, top row first).
   */
  private composeExportRows(
    plan: RasterPlan,
    layer: ComposeLayer | LayerState,
    transparent: boolean,
    y0: number,
    rows: number,
    read: (tx: number, ty: number, tw: number, th: number) => void,
  ): void {
    const gpu = this.requireGpu();
    const { gl } = this;
    const fbo = gpu.exportTarget(plan.tileW, plan.tileH);
    for (let ty = y0; ty < y0 + rows; ty += plan.tileH) {
      for (let tx = 0; tx < plan.width; tx += plan.tileW) {
        const tw = Math.min(plan.tileW, plan.width - tx);
        const th = Math.min(plan.tileH, y0 + rows - ty);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, tw, th);
        // No flip: framebuffer row 0 is the tile's top row, so readPixels returns rows top-down.
        this.compose({
          zoom: plan.scale,
          originX: plan.margin * plan.scale,
          originY: plan.margin * plan.scale,
          exact: true,
          fragX: tx,
          fragY: ty,
          flipY: false,
          outsideClear: false,
          transparent,
          premultiply: false,
          split: null,
        }, layer);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        read(tx, ty, tw, th);
      }
    }
  }

  renderRaster(options: RasterOptions): HTMLCanvasElement | OffscreenCanvas {
    const plan = this.rasterPlan(options);
    const { gl } = this;
    const data = new Uint8ClampedArray(plan.width * plan.height * 4);
    // Each tile lands at its place in the full image: rows are plan.width px apart.
    gl.pixelStorei(gl.PACK_ROW_LENGTH, plan.width);
    try {
      this.composeExportRows(plan, { cells: 'main', mode: this.params!.mode }, options.transparentBackground, 0, plan.height, (tx, ty, tw, th) => {
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, data, (ty * plan.width + tx) * 4);
      });
    } finally {
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this.requireGpu().trimExportTarget();
    const { canvas, ctx } = createRasterCanvas(plan.width, plan.height);
    ctx.putImageData(new ImageData(data, plan.width, plan.height), 0, 0);
    return canvas;
  }

  /**
   * renderRaster's pixels without blocking: every tile is composed and its readback queued right
   * away (into pixel-pack buffers), then the GPU is awaited without stalling the main thread. A
   * raster over READ_BATCH_BYTES is read in batches, all composed from the picture as it was at
   * the call (LayerState), so the user can keep editing, playing or close the file meanwhile.
   */
  async readRaster(options: RasterOptions): Promise<RasterPixels> {
    const plan = this.rasterPlan(options);
    const gpu = this.requireGpu();
    const { gl } = this;
    const { width, height } = plan;
    const rowBytes = width * 4;
    const data = new Uint8ClampedArray(rowBytes * height);
    const bandRows = plan.tileH * Math.max(1, Math.floor(READ_BATCH_BYTES / (plan.tileH * rowBytes)));
    const frozen = this.freezeLayer(gpu);
    try {
      for (let y0 = 0; y0 < height; y0 += bandRows) {
        if (this.gpu !== gpu) throw new Error('The GPU was reset during the export. Try again.');
        // New glyphs replace the atlases a frozen layer's glyph indices refer to.
        if (this.glyphs !== frozen.glyphs) throw new Error('The font, characters or line height changed while the picture was being exported; export it again.');
        const rows = Math.min(bandRows, height - y0);
        const buffer = gpu.packBuffers.acquire(rows * rowBytes);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, width);
        try {
          this.composeExportRows(plan, frozen, options.transparentBackground, y0, rows, (tx, ty, tw, th) => {
            gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, ((ty - y0) * width + tx) * 4);
          });
        } finally {
          gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        try {
          await fenceAndWait(gl);
          if (this.gpu !== gpu) throw new Error('The GPU was reset during the export. Try again.');
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data, y0 * rowBytes, rows * rowBytes);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        } finally {
          if (this.gpu === gpu) gpu.packBuffers.release(buffer);
        }
      }
    } finally {
      gl.deleteTexture(frozen.cell);
    }
    this.gpu?.trimExportTarget();
    return { width, height, data };
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.timer?.dispose();
    this.gpu?.dispose();
    this.gpu = null;
    this.timer = null;
    this.source = null;
    this.probeData = null;
    // Browsers cap live WebGL contexts; give this one back now rather than at garbage collection.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics (dev/engine.html, tests/e2e/engine.spec.ts): not part of AsciiEngine.

  glyphSetup(): AnalysisSetup {
    return this.requireGlyphs().setup;
  }

  /** Pass 1 / 1b output, read back: what the CPU reference must be fed to reproduce pass 2. */
  readAnalysis(): AnalysisReadback {
    const gpu = this.requireGpu();
    if (!this.analyse()) throw new Error('Nothing analysed yet.');
    const a = gpu.analysis!;
    const rgbaL = gpu.readTexture(a.lightness, a.width, a.height, true);
    const lightness = new Float32Array(a.width * a.height);
    for (let i = 0; i < lightness.length; i++) lightness[i] = rgbaL[i * 4];
    return {
      width: a.width,
      height: a.height,
      lightness,
      quadWidth: a.quadWidth,
      quadHeight: a.quadHeight,
      quadColours: gpu.readTexture(a.quads, a.quadWidth, a.quadHeight, true),
    };
  }

  /**
   * Re-runs pass 2 alone with the given quadrant colours (RGBA, 2·cols × 2·rows) in place of
   * pass 1b's, and returns that grid: blocks' two-colour fit can then be fed exactly what the
   * CPU reference computes from the same analysis image. The next render re-analyses normally.
   */
  analyseWithQuadColours(colours: Float32Array): GridSnapshot {
    const gpu = this.requireGpu();
    if (!this.analyse()) throw new Error('Nothing analysed yet.');
    const a = gpu.analysis!;
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, a.quads);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, a.quadWidth, a.quadHeight, gl.RGBA, gl.FLOAT, colours);
    this.runCells(gpu, 'main', this.params!, this.glyphs!.setup, false);
    this.analysisChanged(false);
    return this.readSnapshot(gpu);
  }

  /** Blocks until the source upload has completed on the GPU (a 1-texel readback). */
  waitForSourceUpload(): void {
    const gpu = this.requireGpu();
    gpu.readTexture(gpu.source, 1, 1, false);
  }

  /**
   * The source texture's level 0 (straight RGBA8) as the passes' texelFetch sees it: the exact
   * pixels pass 1 resamples. Copied by a shader because reading a texture uploaded from a <video>
   * through a framebuffer attachment returns garbage on ANGLE / Metal.
   */
  readSourcePixels(): { rgba: Uint8Array; width: number; height: number } {
    const gpu = this.requireGpu();
    const { gl } = this;
    const { width, height } = gpu.sourceSize;
    const target = createTexture(gl, width, height, TEX.RGBA8);
    const fbo = createFramebuffer(gl, [target]);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(gpu.vao);
    gpu.program('copy-source').use().texture('uSrc', 0, gpu.source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);
    return { rgba, width, height };
  }

  /** Renders the preview and reads the default framebuffer back in the same task (top-down RGBA). */
  readPreview(viewport: Viewport): { rgba: Uint8Array; width: number; height: number; layout: ViewLayout } {
    this.render(viewport);
    const grid = this.getGrid();
    const { geometry } = this.requireGlyphs().setup;
    const layout = layoutView(viewport, grid.cols * geometry.cellW, grid.rows * geometry.cellH);
    const { gl } = this;
    const { width, height } = layout;
    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const rgba = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) rgba.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return { rgba, width, height, layout };
  }

  /**
   * GPU-synchronised timings of one full frame for the viewport: the analysis is forced, and each
   * stage ends with a 1-pixel readPixels from the target it wrote (which waits for that work).
   */
  profile(viewport: Viewport): FrameProfile {
    const gpu = this.requireGpu();
    const { gl } = this;
    const grid = this.getGrid();
    const { geometry } = this.requireGlyphs().setup;
    const layout = layoutView(viewport, grid.cols * geometry.cellW, grid.rows * geometry.cellH);
    this.sizeCanvas(viewport, layout);
    const syncPreview = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    };
    syncPreview();
    const t0 = performance.now();
    this.analysed = false;
    if (!this.analyse()) throw new Error('Nothing to analyse.');
    const cells = gpu.cells!;
    gpu.readTexture(cells.sets[cells.current].cell, 1, 1, true);
    const t1 = performance.now();
    this.composePreview(layout, viewport.transparentBackground ?? false);
    syncPreview();
    const t2 = performance.now();
    return { analysisMs: t1 - t0, composeMs: t2 - t1, totalMs: t2 - t0 };
  }

  gpuInfo(): { renderer: string; vendor: string; maxTextureSize: number; maxRasterSize: number; parallelCompile: boolean; timerQuery: boolean } {
    const { gl } = this;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRasterSize: this.maxRasterSize,
      parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
      timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    };
  }

  compiledPrograms(): string[] {
    return this.gpu?.compiledPrograms() ?? [];
  }

  allocations(): ReturnType<GpuResources['allocations']> | null {
    return this.gpu?.allocations() ?? null;
  }

  /** Current params (copy), for harnesses. */
  currentParams(): RenderParams | null {
    return this.params ? { ...this.params } : null;
  }
}

function unit(rgb: readonly [number, number, number]): [number, number, number] {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}
