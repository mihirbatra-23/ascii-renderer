/**
 * Engine contracts. Everything outside src/engine talks to the renderer through these types.
 * The normative algorithm is docs/ALGORITHM.md.
 *
 * Geometry invariant (the structural fix for the old "export shrinks width/height" bug):
 * ONE cell geometry (integer cellW x cellH px derived from the font's real advance and line
 * height) is shared by analysis, the live preview, PNG/GIF/video export, SVG, HTML and TXT.
 * rows = round(cols * srcH / srcW * cellW / cellH), so every output keeps the source aspect to
 * within half a row.
 */

export type RenderMode = 'shape' | 'ramp' | 'braille' | 'blocks' | 'halftone';

export type ColorMode = 'mono' | 'source' | 'duotone';

/** Threshold pattern for braille / blocks; 'noise' is a tiled blue-noise texture. All are screen-locked. */
export type DitherPattern = 'none' | 'ordered' | 'noise';

export type HalftoneShape = 'round' | 'square' | 'diamond' | 'line';

export type FontId = 'jetbrains-mono' | 'ibm-plex-mono' | 'geist-mono';

export type CharsetPreset = 'ascii' | 'minimal' | 'dense' | 'lines' | 'custom';

export interface RenderParams {
  mode: RenderMode;
  /** Grid width in characters (20–400). */
  columns: number;

  // Glyphs
  charsetPreset: CharsetPreset;
  /** Used when charsetPreset === 'custom'. */
  customCharset: string;
  font: FontId;
  /** Line-height factor; cell aspect k = lineHeight / advanceEm (1.0–1.6, default 1.2). */
  lineHeight: number;

  // Tone (docs/ALGORITHM.md §3)
  autoLevels: boolean;
  /** -0.5..0.5 */
  brightness: number;
  /** Tonal contrast 0.5..2 (1 = unchanged). */
  contrast: number;
  /** 0.4..2.5 */
  gamma: number;
  invert: boolean;

  // Shape matching (§5)
  /** Global contrast exponent, 1..4 (default 1.5). */
  shapeSharpness: number;
  /** Directional contrast exponent, 1..4 (default 1.75). */
  edgeSharpness: number;
  /** Cell-locked (blue-noise) tone dither amount for shape / ramp, 0..0.5 (default 0.05). */
  dither: number;

  // Braille / blocks / halftone (§6)
  ditherPattern: DitherPattern;
  halftoneAngle: number;
  halftoneShape: HalftoneShape;

  // Colour (§7): CSS hex strings (#rrggbb)
  colorMode: ColorMode;
  ink: string;
  paper: string;
  /** Duotone shadow colour. */
  shadowInk: string;

  /** Video/GIF temporal stability 0..1 (§8). Ignored for stills. */
  stability: number;

  /** Edge layer (shape / ramp modes): draw contour strokes (| / \\ _ -) where the image has strong edges. */
  edges: boolean;
  /** Edge detection threshold 0..1 (higher = fewer, stronger edges). */
  edgeThreshold: number;
}

export const DEFAULT_PARAMS: RenderParams = {
  mode: 'shape',
  columns: 160,
  charsetPreset: 'ascii',
  customCharset: '',
  font: 'jetbrains-mono',
  lineHeight: 1.2,
  autoLevels: true,
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  shapeSharpness: 1.5,
  edgeSharpness: 1.75,
  dither: 0.05,
  ditherPattern: 'ordered',
  halftoneAngle: 45,
  halftoneShape: 'round',
  colorMode: 'mono',
  ink: '#e8e6df',
  paper: '#0b0b0c',
  shadowInk: '#3b5bdb',
  stability: 0.5,
  edges: false,
  edgeThreshold: 0.5,
};

export interface CellGeometry {
  /** Integer px per cell at scale 1. */
  cellW: number;
  cellH: number;
  /** Font size (px) that makes the font's advance exactly cellW. */
  fontSize: number;
  /** Alphabetic baseline offset from the top of the cell (px, scale 1). */
  baseline: number;
  /** CSS font-family string for the bundled font (e.g. '"JetBrains Mono"'). */
  fontFamily: string;
  /** Measured advance width in em. */
  advanceEm: number;
}

export interface GridSize {
  cols: number;
  rows: number;
}

/** A frame the engine can sample (passed straight to texImage2D / drawImage). */
export type FrameSource =
  | ImageBitmap
  | HTMLVideoElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | VideoFrame
  | HTMLImageElement;

export interface SourceInfo {
  /** Display size (EXIF / container rotation already applied). */
  width: number;
  height: number;
  /** True for GIF / video frames: enables temporal stability (§8). */
  animated: boolean;
}

export interface Levels {
  black: number;
  white: number;
}

/** CPU-side snapshot of the analysed grid: the single source for TXT / SVG / HTML export and copy. */
export interface GridSnapshot extends GridSize {
  /** One string per cell, row-major (braille / blocks are non-ASCII). */
  chars: string[];
  /** Per-cell RGB 0..255 (length cols*rows*3): mean source colour (colour modes). */
  colors: Uint8Array;
  /** Blocks colour mode only: per-cell background RGB (length cols*rows*3). */
  backgrounds?: Uint8Array;
  /** Per-cell tone-mapped lightness / coverage 0..1 (halftone dot size, ramp fallback). */
  tone: Float32Array;
  geometry: CellGeometry;
  params: RenderParams;
}

export interface RenderStats extends GridSize {
  /** Wall-clock ms spent producing the last frame (analysis + compose). */
  ms: number;
}

export interface Viewport {
  /** CSS pixel size of the preview element. */
  width: number;
  height: number;
  devicePixelRatio: number;
  /** 'fit' scales the grid to fit with a small margin; a number is CSS px per output px. */
  zoom: 'fit' | number;
  /** Pan offset in CSS px (zoomed views). */
  panX: number;
  panY: number;
  /** Compare split position 0..1 from the left (source shown left of it); null = compare off. */
  compare: number | null;
  /** Show the untouched source instead of the render. */
  showSource: boolean;
  /** What the left side of the compare split shows: the source image (default) or a plain density-ramp render. */
  compareWith?: 'source' | 'ramp';
  /**
   * Preview the paper as transparent, exactly as RasterOptions.transparentBackground exports it
   * (the canvas then shows whatever is behind it, e.g. a checker). Default false.
   */
  transparentBackground?: boolean;
}

export interface RasterOptions {
  /** Integer output scale. Output size is exactly (cols*cellW + 2*margin)*scale x (rows*cellH + 2*margin)*scale. */
  scale: number;
  /** Margin in scale-1 px around the grid (default 0). */
  margin?: number;
  transparentBackground: boolean;
}

export interface AsciiEngine {
  /** The preview canvas the engine draws into (attach it to the DOM). */
  readonly canvas: HTMLCanvasElement;
  /** Load fonts and build glyph data for the given params. Must be awaited once before first render. */
  setParams(params: RenderParams): Promise<void>;
  /** Replace the source frame. Cheap to call every video frame. */
  setSource(source: FrameSource, info: SourceInfo): void;
  /** Explicit levels (auto-levels are computed by the caller once per still / clip via measureLevels). */
  setLevels(levels: Levels): void;
  /** Forget temporal history (call on seek / new media). */
  resetHistory(): void;
  getGrid(): GridSize;
  getGeometry(): CellGeometry;
  /** Run analysis if anything changed, then draw the preview for the viewport. */
  render(viewport: Viewport): RenderStats;
  /** Read back the current grid (runs analysis first if needed). */
  snapshot(): GridSnapshot;
  /** Render the current grid at an exact export size into a fresh 2D canvas. */
  renderRaster(options: RasterOptions): HTMLCanvasElement | OffscreenCanvas;
  /**
   * Like renderRaster, but reads pixels back asynchronously (pixel-pack buffer + fence on WebGL2) so long
   * exports don't block the main thread. Same exact size and pixels as renderRaster.
   */
  readRaster(options: RasterOptions): Promise<RasterPixels>;
  /** Maximum raster edge the device supports (px). */
  readonly maxRasterSize: number;
  /** Cheap lookup of one cell of the last analysed grid (for the cursor probe); null outside the grid. */
  probe(col: number, row: number): CellProbe | null;
  /** Compile every mode's programs ahead of time (idle-time, parallel where supported) so mode switches never stall. */
  warmup(): Promise<void>;
  /**
   * Timing of the last rendered frame: GPU time when the timer-query extension exists, else null.
   * GPU times cover frames that ran the analysis (view-only redraws are not timed into them);
   * `gpuSamples` lists each such frame's GPU ms that arrived since the previous call, oldest first.
   */
  getTimings(): { gpuMs: number | null; cpuMs: number; gpuSamples?: number[] };
  /** Free source-sized GPU memory (call when media is closed); the next setSource re-allocates. */
  releaseSource(): void;
  dispose(): void;
}

/** Straight-alpha RGBA pixels, top row first. */
export interface RasterPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface CellProbe {
  col: number;
  row: number;
  char: string;
  /** Tone-mapped lightness 0..1. */
  tone: number;
  /**
   * True when the answer comes from an earlier analysed frame because the latest one is still on its
   * way back from the GPU (the probe never waits for it): ask again on a later animation frame.
   */
  pending?: boolean;
}
