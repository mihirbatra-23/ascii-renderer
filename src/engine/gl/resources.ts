/**
 * Every WebGL object the renderer owns, created for one context. On context loss the whole
 * instance is dropped and a new one is built on restore.
 *
 * Public API
 *   GpuResources
 *     program(key)                    the compiled program (waits for a warmup compile still running)
 *     readyProgram(key)               the program if ready, else null while it compiles in the background
 *     warmup(keys)                    → Promise: compiles programs in the background
 *                                     (KHR_parallel_shader_compile, else one per idle slice)
 *     setGlyphData(state)             glyph and tap uniform buffers; drops atlases built for older glyphs
 *     uploadSource(frame)             RGBA8 level 0; returns false while the frame has no pixels
 *     ensureSourceMips()              builds the source mip chain on demand → highest level
 *     ensureAnalysis(grid, w, h)      pass 1 lightness (R32F, w × h) and pass 1b quadrant colours
 *                                     (RGBA32F, 2·cols × 2·rows) targets
 *     ensureEdges(w, h)               §5b targets at analysis size: Gaussian pair (RG32F), DoG (R32F)
 *     ensureCells(which, cols, rows)  → true when (re)allocated: ping-pong MRT sets of pass 2, for the
 *                                     render ('main') or the compare view's ramp render ('compare')
 *     clearHistory(which)             marks every cell's §8 history invalid
 *     atlas(scale, chars, geometry, pad)  cached glyph atlas at an integer scale (LRU)
 *     previewRaster(w, h)             RGBA8 target for the minified preview (the grid at scale 1)
 *     exportTarget(w, h)              RGBA8 framebuffer of at least w × h for export tiles
 *     trimExportTarget()              frees the export tile when it is larger than worth keeping
 *     packBuffers                     pixel-pack buffers for asynchronous readback
 *     readTexture(texture, w, h, format)  synchronous readPixels of any colour texture
 *     releaseSourceMemory()           frees everything sized by the source or the grid
 *     compiledPrograms(), allocations()   diagnostics
 *     dispose()
 */
import type { CellGeometry, FrameSource } from '../types';
import { blueNoise64, BLUE_NOISE_SIZE } from '../dither';
import { browserCanvasFactory } from '../canvas';
import { checkRenderTargets, createFramebuffer, createTexture, finishProgram, programReady, startProgram, TEX, type GL, type PendingProgram, type Program } from './gl';
import { packGlyphs, packTaps } from './data';
import { FULLSCREEN_VS, fragmentSource, type ProgramKey } from './shaders';
import { buildGlyphAtlas, type GlyphAtlas, type InkPadding } from './glyphAtlas';
import type { GlyphState } from './glyphs';
import { fitFrame, frameSize } from './frame';
import { PackBuffers } from './readback';

export interface CellSet {
  /** (glyph index, tone, packed fg RGB, packed bg RGB) per cell. */
  cell: WebGLTexture;
  /** §8 filtered features 0..3 and 4..7. */
  histA: WebGLTexture;
  histB: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export interface AnalysisTargets {
  width: number;
  height: number;
  lightness: WebGLTexture;
  fbo: WebGLFramebuffer;
  /** One texel per block quadrant: 2·cols × 2·rows. */
  quadWidth: number;
  quadHeight: number;
  quads: WebGLTexture;
  quadFbo: WebGLFramebuffer;
}

export interface EdgeTargets {
  width: number;
  height: number;
  blur: WebGLTexture;
  blurFbo: WebGLFramebuffer;
  dog: WebGLTexture;
  dogFbo: WebGLFramebuffer;
}

export interface CellTargets {
  cols: number;
  rows: number;
  sets: [CellSet, CellSet];
  /** Index of the set holding the latest result. */
  current: 0 | 1;
}

export type CellsKind = 'main' | 'compare';

export interface GlyphData {
  /** The `Glyphs` block (data.ts packGlyphs). */
  ubo: WebGLBuffer;
  /** The `Taps` block of this geometry (data.ts packTaps). */
  taps: WebGLBuffer;
  count: number;
}

interface RasterTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

const ATLAS_CACHE = 4;
/** An export tile larger than this is freed after use instead of kept for the next frame. */
const KEEP_EXPORT_BYTES = 16 << 20;
const COMPLETION_POLL_MS = 16;
/** A background program (pass 2 specialised for a geometry) starts compiling once input has paused this long. */
const IDLE_COMPILE_MS = 400;

export class GpuResources {
  readonly vao: WebGLVertexArrayObject;
  readonly noise: WebGLTexture;
  readonly source: WebGLTexture;
  readonly packBuffers: PackBuffers;
  sourceSize = { width: 0, height: 0 };
  private sourceMips = false;
  glyphData: GlyphData | null = null;
  analysis: AnalysisTargets | null = null;
  edges: EdgeTargets | null = null;
  private readonly cellTargets: Record<CellsKind, CellTargets | null> = { main: null, compare: null };
  private readonly programs = new Map<ProgramKey, Program>();
  private readonly compiling = new Map<ProgramKey, PendingProgram>();
  private readonly parallelCompile: boolean;
  private readonly atlases = new Map<number, GlyphAtlas>();
  private exportFbo: RasterTarget | null = null;
  private preview: RasterTarget | null = null;
  private deferred: { key: ProgramKey; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly gl: GL,
    private readonly maxTextureSize: number,
  ) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create a vertex array');
    this.vao = vao;
    this.noise = createTexture(gl, BLUE_NOISE_SIZE, BLUE_NOISE_SIZE, TEX.R32F, blueNoise64());
    this.source = createTexture(gl, 1, 1, TEX.RGBA8, new Uint8Array(4), gl.LINEAR);
    this.packBuffers = new PackBuffers(gl);
    // Once per context, so creating targets later never waits on a GPU round trip (see createFramebuffer).
    checkRenderTargets(gl, [[TEX.R32F], [TEX.RG32F], [TEX.RGBA32F], [TEX.RGBA32F, TEX.RGBA32F, TEX.RGBA32F], [TEX.RGBA8]]);
    this.parallelCompile = !!gl.getExtension('KHR_parallel_shader_compile');
  }

  get cells(): CellTargets | null {
    return this.cellTargets.main;
  }

  cellsOf(which: CellsKind): CellTargets | null {
    return this.cellTargets[which];
  }

  program(key: ProgramKey): Program {
    let p = this.programs.get(key);
    if (!p) {
      const pending = this.compiling.get(key) ?? startProgram(this.gl, FULLSCREEN_VS, fragmentSource(key), key);
      this.compiling.delete(key);
      p = finishProgram(this.gl, pending);
      this.programs.set(key, p);
    }
    return p;
  }

  /**
   * The program if it is compiled (or its background compile has just finished); otherwise returns
   * null, so the caller can use a fallback program meanwhile, and starts compiling it once the same
   * key has been asked for over IDLE_COMPILE_MS (one geometry at a time, the latest requested).
   * The wait matters with KHR_parallel_shader_compile too: a GPU-process compile delays every
   * synchronous GL query behind it, so a line-height drag that started one compile per step would
   * stall on each; this way only the geometry the drag settles on is compiled.
   */
  readyProgram(key: ProgramKey): Program | null {
    const done = this.programs.get(key);
    if (done) return done;
    const pending = this.compiling.get(key);
    if (pending) return programReady(this.gl, pending, this.parallelCompile) ? this.program(key) : null;
    if (this.deferred?.key !== key) {
      if (this.deferred) clearTimeout(this.deferred.timer);
      const timer = setTimeout(() => {
        this.deferred = null;
        // In parallel the compile finishes off the main thread and a later readyProgram picks it up.
        if (this.parallelCompile) this.compiling.set(key, startProgram(this.gl, FULLSCREEN_VS, fragmentSource(key), key));
        else this.program(key);
      }, IDLE_COMPILE_MS);
      this.deferred = { key, timer };
    }
    return null;
  }

  /**
   * Compiles `keys` without blocking the page: with KHR_parallel_shader_compile every compile is
   * issued at once and polled for completion; without it, one program is compiled per task so no
   * single task holds the main thread for more than one compile. Resolves when all are ready.
   */
  async warmup(keys: readonly ProgramKey[], alive: () => boolean): Promise<void> {
    const todo = keys.filter((k) => !this.programs.has(k));
    if (this.parallelCompile) {
      for (const key of todo) {
        if (!this.compiling.has(key)) this.compiling.set(key, startProgram(this.gl, FULLSCREEN_VS, fragmentSource(key), key));
      }
      while (alive()) {
        let waiting = false;
        for (const key of todo) {
          const pending = this.compiling.get(key);
          if (!pending) continue;
          if (programReady(this.gl, pending, true)) this.program(key);
          else waiting = true;
        }
        if (!waiting) return;
        await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
      }
      return;
    }
    for (const key of todo) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!alive()) return;
      this.program(key);
    }
  }

  setGlyphData(state: GlyphState): void {
    const { gl } = this;
    const buffer = (existing: WebGLBuffer | undefined, data: BufferSource) => {
      const ubo = existing ?? gl.createBuffer();
      if (!ubo) throw new Error('Could not create a uniform buffer');
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
      return ubo;
    };
    const ubo = buffer(this.glyphData?.ubo, packGlyphs(state.setup.glyphSet));
    const taps = buffer(this.glyphData?.taps, packTaps(state.setup.taps));
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    this.glyphData = { ubo, taps, count: state.setup.glyphSet.chars.length };
    for (const atlas of this.atlases.values()) gl.deleteTexture(atlas.texture);
    this.atlases.clear();
  }

  /** Level 0 only: mipmaps are built on demand (ensureSourceMips), as most frames never read them. */
  uploadSource(frame: FrameSource): boolean {
    const { gl } = this;
    const fitted = fitFrame(frame, this.maxTextureSize);
    const { width, height } = frameSize(fitted);
    if (width === 0 || height === 0) return false;
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, fitted);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    this.sourceSize = { width, height };
    this.sourceMips = false;
    return true;
  }

  /** Builds the source's mip chain if this frame has none yet; returns the highest level. */
  ensureSourceMips(): number {
    const { gl } = this;
    const levels = Math.floor(Math.log2(Math.max(this.sourceSize.width, this.sourceSize.height))) + 1;
    if (!this.sourceMips) {
      gl.bindTexture(gl.TEXTURE_2D, this.source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.sourceMips = true;
    }
    return levels - 1;
  }

  ensureAnalysis(grid: { cols: number; rows: number }, width: number, height: number): AnalysisTargets {
    const a = this.analysis;
    const quadWidth = grid.cols * 2;
    const quadHeight = grid.rows * 2;
    if (a && a.width === width && a.height === height && a.quadWidth === quadWidth && a.quadHeight === quadHeight) return a;
    if (a) this.deleteAnalysis(a);
    const { gl } = this;
    const lightness = createTexture(gl, width, height, TEX.R32F);
    const quads = createTexture(gl, quadWidth, quadHeight, TEX.RGBA32F);
    this.analysis = {
      width,
      height,
      lightness,
      fbo: createFramebuffer(gl, [lightness]),
      quadWidth,
      quadHeight,
      quads,
      quadFbo: createFramebuffer(gl, [quads]),
    };
    return this.analysis;
  }

  private deleteAnalysis(a: AnalysisTargets): void {
    const { gl } = this;
    gl.deleteFramebuffer(a.fbo);
    gl.deleteFramebuffer(a.quadFbo);
    gl.deleteTexture(a.lightness);
    gl.deleteTexture(a.quads);
    this.analysis = null;
  }

  ensureEdges(width: number, height: number): EdgeTargets {
    const e = this.edges;
    if (e && e.width === width && e.height === height) return e;
    this.deleteEdges();
    const { gl } = this;
    const blur = createTexture(gl, width, height, TEX.RG32F);
    const dog = createTexture(gl, width, height, TEX.R32F);
    this.edges = { width, height, blur, blurFbo: createFramebuffer(gl, [blur]), dog, dogFbo: createFramebuffer(gl, [dog]) };
    return this.edges;
  }

  /** The §5b targets are as large as the analysis image; they exist only while the edge layer is on. */
  deleteEdges(): void {
    const e = this.edges;
    if (!e) return;
    const { gl } = this;
    gl.deleteFramebuffer(e.blurFbo);
    gl.deleteFramebuffer(e.dogFbo);
    gl.deleteTexture(e.blur);
    gl.deleteTexture(e.dog);
    this.edges = null;
  }

  ensureCells(which: CellsKind, cols: number, rows: number): boolean {
    const c = this.cellTargets[which];
    if (c && c.cols === cols && c.rows === rows) return false;
    const { gl } = this;
    this.deleteCells(which);
    const make = (): CellSet => {
      const cell = createTexture(gl, cols, rows, TEX.RGBA32F);
      const histA = createTexture(gl, cols, rows, TEX.RGBA32F);
      const histB = createTexture(gl, cols, rows, TEX.RGBA32F);
      return { cell, histA, histB, fbo: createFramebuffer(gl, [cell, histA, histB]) };
    };
    this.cellTargets[which] = { cols, rows, sets: [make(), make()], current: 0 };
    return true;
  }

  deleteCells(which: CellsKind): void {
    const c = this.cellTargets[which];
    if (!c) return;
    for (const set of c.sets) {
      this.gl.deleteFramebuffer(set.fbo);
      this.gl.deleteTexture(set.cell);
      this.gl.deleteTexture(set.histA);
      this.gl.deleteTexture(set.histB);
    }
    this.cellTargets[which] = null;
  }

  clearHistory(which: CellsKind): void {
    const c = this.cellTargets[which];
    if (!c) return;
    const { gl } = this;
    const invalid = new Float32Array([-1, -1, -1, -1]);
    for (const set of c.sets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, set.fbo);
      gl.clearBufferfv(gl.COLOR, 1, invalid);
    }
  }

  atlas(scale: number, chars: readonly string[], geometry: CellGeometry, pad: InkPadding): GlyphAtlas {
    let atlas = this.atlases.get(scale);
    if (atlas) {
      this.atlases.delete(scale);
    } else {
      atlas = buildGlyphAtlas(this.gl, chars, geometry, pad, scale, browserCanvasFactory);
      if (this.atlases.size >= ATLAS_CACHE) {
        const [oldest, old] = this.atlases.entries().next().value!;
        this.gl.deleteTexture(old.texture);
        this.atlases.delete(oldest);
      }
    }
    this.atlases.set(scale, atlas);
    return atlas;
  }

  private rasterTarget(existing: RasterTarget | null, width: number, height: number): RasterTarget {
    if (existing) this.deleteRaster(existing);
    const texture = createTexture(this.gl, width, height, TEX.RGBA8);
    return { texture, fbo: createFramebuffer(this.gl, [texture]), width, height };
  }

  private deleteRaster(t: RasterTarget): void {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.texture);
  }

  /** Exactly w × h (the minified preview box-filters it texel for texel). */
  previewRaster(width: number, height: number): RasterTarget {
    const p = this.preview;
    if (p && p.width === width && p.height === height) return p;
    this.preview = this.rasterTarget(p, width, height);
    return this.preview;
  }

  exportTarget(width: number, height: number): WebGLFramebuffer {
    const e = this.exportFbo;
    if (e && e.width >= width && e.height >= height) return e.fbo;
    this.exportFbo = this.rasterTarget(e, Math.max(width, e?.width ?? 0), Math.max(height, e?.height ?? 0));
    return this.exportFbo.fbo;
  }

  /** Motion exports reuse a frame-sized tile; a one-off giant PNG tile is not worth keeping. */
  trimExportTarget(): void {
    const e = this.exportFbo;
    if (e && e.width * e.height * 4 > KEEP_EXPORT_BYTES) {
      this.deleteRaster(e);
      this.exportFbo = null;
    }
  }

  /** Reads a w × h region of a colour texture (RGBA/FLOAT for float textures, RGBA/UNSIGNED_BYTE otherwise). */
  readTexture(texture: WebGLTexture, width: number, height: number, float: true): Float32Array;
  readTexture(texture: WebGLTexture, width: number, height: number, float: false): Uint8Array;
  readTexture(texture: WebGLTexture, width: number, height: number, float: boolean): Float32Array | Uint8Array {
    const { gl } = this;
    const fbo = createFramebuffer(gl, [texture]);
    const out = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, width, height, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return out;
  }

  /** Diagnostics: the programs compiled so far. */
  compiledPrograms(): ProgramKey[] {
    return [...this.programs.keys()];
  }

  /** Diagnostics: which source- or grid-sized objects are allocated. */
  allocations(): { source: [number, number]; analysis: boolean; edges: boolean; cells: boolean; compare: boolean; preview: boolean; exportTile: boolean } {
    return {
      source: [this.sourceSize.width, this.sourceSize.height],
      analysis: !!this.analysis,
      edges: !!this.edges,
      cells: !!this.cellTargets.main,
      compare: !!this.cellTargets.compare,
      preview: !!this.preview,
      exportTile: !!this.exportFbo,
    };
  }

  /**
   * Frees what the source and the grid size (source texture → 1 × 1, analysis, edge, cell, preview
   * and export targets, pixel buffers). Everything is recreated lazily by the next analysis.
   */
  releaseSourceMemory(): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.sourceSize = { width: 0, height: 0 };
    this.sourceMips = false;
    if (this.analysis) this.deleteAnalysis(this.analysis);
    this.deleteEdges();
    this.deleteCells('main');
    this.deleteCells('compare');
    if (this.preview) this.deleteRaster(this.preview);
    if (this.exportFbo) this.deleteRaster(this.exportFbo);
    this.preview = null;
    this.exportFbo = null;
    this.packBuffers.dispose();
  }

  dispose(): void {
    const { gl } = this;
    if (this.deferred) clearTimeout(this.deferred.timer);
    this.deferred = null;
    this.releaseSourceMemory();
    for (const p of this.programs.values()) gl.deleteProgram(p.handle);
    this.programs.clear();
    for (const p of this.compiling.values()) {
      gl.deleteProgram(p.handle);
      gl.deleteShader(p.vs);
      gl.deleteShader(p.fs);
    }
    this.compiling.clear();
    for (const atlas of this.atlases.values()) gl.deleteTexture(atlas.texture);
    this.atlases.clear();
    if (this.glyphData) {
      gl.deleteBuffer(this.glyphData.ubo);
      gl.deleteBuffer(this.glyphData.taps);
    }
    gl.deleteTexture(this.noise);
    gl.deleteTexture(this.source);
    gl.deleteVertexArray(this.vao);
  }
}
