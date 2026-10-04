/**
 * State shared by the WebGL2 and CPU engines: params (with glyph rebuilds only when the font,
 * charset or line height change), source, levels, grid and geometry. Subclasses react to the
 * change hooks.
 *
 * Public API
 *   EngineBackend                  'webgl2' | 'cpu'
 *   RendererEngine                 AsciiEngine plus the backend actually in use
 *   EngineBase                     abstract base implementing the bookkeeping half of AsciiEngine
 */
import type {
  AsciiEngine,
  CellGeometry,
  CellProbe,
  FrameSource,
  GridSize,
  GridSnapshot,
  Levels,
  RasterOptions,
  RasterPixels,
  RenderParams,
  RenderStats,
  SourceInfo,
  Viewport,
} from '../types';
import { loadFont } from '../fonts';
import { gridSize } from '../geometry';
import { IDENTITY_LEVELS } from '../tone';
import { affectsAnalysis, glyphKey } from './params';
import { buildGlyphState, type GlyphState } from './glyphs';

export type EngineBackend = 'webgl2' | 'cpu';

export interface RendererEngine extends AsciiEngine {
  readonly backend: EngineBackend;
}

export abstract class EngineBase implements RendererEngine {
  abstract readonly backend: EngineBackend;
  abstract readonly canvas: HTMLCanvasElement;
  abstract readonly maxRasterSize: number;

  protected params: RenderParams | null = null;
  protected glyphs: GlyphState | null = null;
  protected levels: Levels = { ...IDENTITY_LEVELS };
  protected source: FrameSource | null = null;
  protected info: SourceInfo | null = null;
  private paramsToken = 0;

  async setParams(params: RenderParams): Promise<void> {
    const token = ++this.paramsToken;
    if (this.glyphs?.key !== glyphKey(params)) {
      await loadFont(params.font);
      // A newer call superseded this one while the font loaded; it applies its own params.
      if (token !== this.paramsToken) return;
      this.glyphs = buildGlyphState(params);
      this.glyphsChanged();
    }
    const prev = this.params;
    this.params = { ...params };
    if (!prev || affectsAnalysis(prev, params)) this.analysisChanged(true);
  }

  setSource(source: FrameSource, info: SourceInfo): void {
    const prev = this.info;
    this.source = source;
    this.info = { ...info };
    const reset = !prev || prev.animated !== info.animated || prev.width !== info.width || prev.height !== info.height;
    this.sourceChanged();
    this.analysisChanged(reset);
  }

  setLevels(levels: Levels): void {
    if (levels.black === this.levels.black && levels.white === this.levels.white) return;
    this.levels = { black: levels.black, white: levels.white };
    if (this.params?.autoLevels) this.analysisChanged(true);
  }

  resetHistory(): void {
    this.analysisChanged(true);
  }

  releaseSource(): void {
    this.source = null;
    this.info = null;
    this.sourceReleased();
    this.analysisChanged(true);
  }

  getGrid(): GridSize {
    if (!this.info || !this.params || !this.glyphs) return { cols: 0, rows: 0 };
    return gridSize(this.info.width, this.info.height, this.params.columns, this.glyphs.setup.geometry);
  }

  getGeometry(): CellGeometry {
    return this.requireGlyphs().setup.geometry;
  }

  protected requireGlyphs(): GlyphState {
    if (!this.glyphs) throw new Error('Call and await engine.setParams() before rendering.');
    return this.glyphs;
  }

  protected requireReady(): { params: RenderParams; glyphs: GlyphState; info: SourceInfo; source: FrameSource } {
    const glyphs = this.requireGlyphs();
    if (!this.params || !this.info || !this.source) throw new Error('No source: call engine.setSource() first.');
    return { params: this.params, glyphs, info: this.info, source: this.source };
  }

  /** New glyph data: geometry, vectors and atlases are stale. */
  protected abstract glyphsChanged(): void;
  /** A new frame was set (the analysis hook follows). */
  protected abstract sourceChanged(): void;
  /** The analysis is stale; `resetHistory` also discards the §8 temporal state. */
  protected abstract analysisChanged(resetHistory: boolean): void;
  /** The source was dropped (releaseSource): free whatever is sized by it. */
  protected abstract sourceReleased(): void;

  abstract render(viewport: Viewport): RenderStats;
  abstract snapshot(): GridSnapshot;
  abstract renderRaster(options: RasterOptions): HTMLCanvasElement | OffscreenCanvas;
  abstract readRaster(options: RasterOptions): Promise<RasterPixels>;
  abstract probe(col: number, row: number): CellProbe | null;
  abstract warmup(): Promise<void>;
  abstract getTimings(): { gpuMs: number | null; cpuMs: number; gpuSamples?: number[] };
  abstract dispose(): void;
}

/** Validates integer scale / margin and the device edge limit, returning the exact size. */
export function checkRaster(
  options: RasterOptions,
  size: { width: number; height: number },
  maxEdge: number,
): { scale: number; margin: number } {
  const margin = options.margin ?? 0;
  if (!Number.isInteger(options.scale) || options.scale < 1) {
    throw new RangeError(`Raster scale must be a whole number ≥ 1 (got ${options.scale}).`);
  }
  if (!Number.isInteger(margin) || margin < 0) {
    throw new RangeError(`Raster margin must be a whole number of px ≥ 0 (got ${margin}).`);
  }
  if (size.width > maxEdge || size.height > maxEdge) {
    throw new Error(
      `The export would be ${size.width} × ${size.height} px. This device can draw up to ${maxEdge} px per side. ` +
        'Lower the scale or columns.',
    );
  }
  return { scale: options.scale, margin };
}
