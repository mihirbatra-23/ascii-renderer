/**
 * Export harness (dev only): a fake AsciiEngine that honours the raster-size contract, plus probes
 * that decode exporter output (gifuct-js, Mediabunny) so tests/e2e/export.spec.ts can verify it.
 */
import jetbrainsWoff2Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import { decompressFrames, parseGIF } from 'gifuct-js';
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
} from 'mediabunny';
import { buildGlyphSet, type CanvasFactory, type GlyphContext } from '../src/engine/atlas';
import { resolveCharset } from '../src/engine/charsets';
import { analyzeCpu, toSnapshot } from '../src/engine/cpu';
import { FONTS, loadFont } from '../src/engine/fonts';
import { analysisSize, computeGeometry, gridSize, measureFontMetrics } from '../src/engine/geometry';
import { buildTapTables } from '../src/engine/layout';
import { renderRasterCpu } from '../src/engine/rasterCpu';
import {
  DEFAULT_PARAMS,
  type AsciiEngine,
  type CellGeometry,
  type FrameSource,
  type CellProbe,
  type GridSize,
  type GridSnapshot,
  type RasterOptions,
  type RasterPixels,
  type RenderParams,
  type RenderStats,
  type SourceInfo,
} from '../src/engine/types';
import {
  animationFrames,
  animationSamples,
  animationSpans,
  estimateExport,
  exportGif,
  exportHtml,
  exportPng,
  exportSvg,
  exportVideo,
  isAbortError,
  snapshotToHtml,
  startRecording,
  gifFps,
  gifRepeatCount,
  videoFrames,
  videoFrameTimes,
  videoSamples,
  type ExportFrame,
  type ExportOptions,
  type ExportProgress,
  type ExportResult,
} from '../src/export';
import { loadMedia, openCamera } from '../src/media';
import { GifWriter } from '../src/export/gif-writer';
import { lifetimeMembers } from '../src/media/lifetime';
import type { LoadedVideo } from '../src/media/types';

// ---------------------------------------------------------------------------------------------
// Fake engine

const BASE_GEOMETRY: CellGeometry = {
  cellW: 8,
  cellH: 17, // odd on purpose: odd raster heights exercise the video padding path
  fontSize: 8 / 0.6,
  baseline: 13,
  fontFamily: '"JetBrains Mono"',
  advanceEm: 0.6,
};

interface FakeEngineOptions {
  params?: Partial<RenderParams>;
  geometry?: Partial<CellGeometry>;
  maxRasterSize?: number;
}

const hex = (s: string) => parseInt(s.slice(1), 16);
const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const css = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;

/** Draws each cell as a box sized by the source lightness, coloured per colour mode; exact contract sizes. */
class FakeEngine implements AsciiEngine {
  readonly canvas = document.createElement('canvas');
  readonly maxRasterSize: number;
  params: RenderParams;
  geometry: CellGeometry;
  resets = 0;
  private source: FrameSource | null = null;
  private info: SourceInfo = { width: 320, height: 180, animated: false };
  private readonly sampler = new OffscreenCanvas(1, 1);

  constructor(options: FakeEngineOptions = {}) {
    this.params = { ...DEFAULT_PARAMS, columns: 80, ...options.params };
    this.geometry = { ...BASE_GEOMETRY, ...options.geometry };
    this.maxRasterSize = options.maxRasterSize ?? 16384;
  }

  async setParams(params: RenderParams): Promise<void> {
    this.params = params;
  }
  setSource(source: FrameSource, info: SourceInfo): void {
    this.source = source;
    this.info = info;
  }
  setLevels(): void {}
  resetHistory(): void {
    this.resets++;
  }
  getGrid(): GridSize {
    const cols = this.params.columns;
    const rows = Math.max(1, Math.round(((cols * this.info.height) / this.info.width) * (this.geometry.cellW / this.geometry.cellH)));
    return { cols, rows };
  }
  getGeometry(): CellGeometry {
    return this.geometry;
  }
  render(): RenderStats {
    return { ...this.getGrid(), ms: 0 };
  }
  dispose(): void {}
  probe(col: number, row: number): CellProbe | null {
    const { cols, rows } = this.getGrid();
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    const snap = this.snapshot();
    const i = row * cols + col;
    return { col, row, char: snap.chars[i], tone: snap.tone[i] };
  }
  async warmup(): Promise<void> {}
  getTimings(): { gpuMs: number | null; cpuMs: number } {
    return { gpuMs: null, cpuMs: 0 };
  }
  releaseSource(): void {
    this.source = null;
  }
  readsInFlight = 0;
  /**
   * Renders at call time (like the real engine) and resolves on a later task with caller-owned
   * pixels, so exporters are exercised with a genuinely asynchronous readback.
   */
  async readRaster(options: RasterOptions): Promise<RasterPixels> {
    const canvas = this.renderRaster(options);
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    this.readsInFlight++;
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.readsInFlight--;
    return { width: canvas.width, height: canvas.height, data };
  }

  /** Mean colour per cell (RGBA), by letting the browser downscale the source. */
  private cellPixels(): Uint8ClampedArray {
    const { cols, rows } = this.getGrid();
    this.sampler.width = cols;
    this.sampler.height = rows;
    const ctx = this.sampler.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cols, rows);
    if (this.source) ctx.drawImage(this.source as CanvasImageSource, 0, 0, cols, rows);
    return ctx.getImageData(0, 0, cols, rows).data;
  }

  snapshot(): GridSnapshot {
    const { cols, rows } = this.getGrid();
    const px = this.cellPixels();
    const ramp = ' .:-=+*#%@';
    const n = cols * rows;
    const chars: string[] = [];
    const colors = new Uint8Array(n * 3);
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
      tone[i] = L;
      chars.push(ramp[Math.min(ramp.length - 1, Math.floor(L * ramp.length))]);
      colors.set([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], i * 3);
    }
    return { cols, rows, chars, colors, tone, geometry: this.geometry, params: this.params };
  }

  renderRaster(options: RasterOptions): OffscreenCanvas {
    const { cols, rows } = this.getGrid();
    const { cellW, cellH } = this.geometry;
    const s = options.scale;
    const m = options.margin ?? 0;
    const out = new OffscreenCanvas((cols * cellW + 2 * m) * s, (rows * cellH + 2 * m) * s);
    const ctx = out.getContext('2d')!;
    if (!options.transparentBackground) {
      ctx.fillStyle = this.params.paper;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    const px = this.cellPixels();
    const ink = rgb(hex(this.params.ink));
    const shadow = rgb(hex(this.params.shadowInk));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        const L = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        if (L < 0.02) continue;
        if (this.params.colorMode === 'source') {
          const k = 255 / Math.max(px[i], px[i + 1], px[i + 2], 64);
          ctx.fillStyle = css(px[i] * k, px[i + 1] * k, px[i + 2] * k);
        } else if (this.params.colorMode === 'duotone') {
          const t = L * L * (3 - 2 * L);
          ctx.fillStyle = css(...(shadow.map((v, k) => v + (ink[k] - v) * t) as [number, number, number]));
        } else {
          ctx.fillStyle = this.params.ink;
        }
        // Fractional box edges give anti-aliased ink/paper blends, like real glyphs.
        const f = 0.9 * Math.sqrt(L);
        const w = cellW * s * f;
        const h = cellH * s * f;
        ctx.fillRect((m + c * cellW) * s + (cellW * s - w) / 2, (m + r * cellH) * s + (cellH * s - h) / 2, w, h);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Synthetic media and probes

function syntheticFrame(i: number, n: number, width = 320, height = 180): OffscreenCanvas {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d')!;
  const hue = (i / n) * 360;
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, `hsl(${hue} 80% 25%)`);
  g.addColorStop(1, `hsl(${(hue + 120) % 360} 80% 60%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(30 + ((width - 60) * i) / Math.max(1, n - 1), height / 2, height / 4, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

async function* syntheticFrames(durations: number[], width = 320, height = 180): AsyncGenerator<ExportFrame> {
  for (let i = 0; i < durations.length; i++) {
    yield { source: syntheticFrame(i, durations.length, width, height), info: { width, height, animated: true }, durationMs: durations[i] };
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function canvasPng(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob = 'convertToBlob' in canvas ? await canvas.convertToBlob() : await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!)));
  return toBase64(blob);
}

/** NETSCAPE2.0 loop count read straight from the bytes (-1 when absent = play once). */
function gifLoopCount(bytes: Uint8Array): number {
  const id = new TextEncoder().encode('NETSCAPE2.0');
  outer: for (let i = 0; i + id.length + 4 < bytes.length; i++) {
    for (let k = 0; k < id.length; k++) if (bytes[i + k] !== id[k]) continue outer;
    return bytes[i + id.length + 2] | (bytes[i + id.length + 3] << 8);
  }
  return -1;
}

function decodeGif(bytes: ArrayBuffer) {
  const parsed = parseGIF(bytes);
  const frames = decompressFrames(parsed, true);
  const localTables = parsed.frames.filter((f) => 'image' in f && f.image.descriptor.lct.exists).length;
  return {
    count: frames.length,
    width: parsed.lsd.width,
    height: parsed.lsd.height,
    delays: frames.map((f) => f.delay),
    globalPaletteSize: parsed.gct.length,
    localTables,
    loop: gifLoopCount(new Uint8Array(bytes)),
    /** Frame rectangles and whether they use transparency (inter-frame deltas). */
    rects: frames.map((f) => ({ ...f.dims })),
    transparent: frames.map((f) => f.transparentIndex !== undefined),
    disposal: frames.map((f) => f.disposalType),
  };
}

/** Every frame of a GIF as a viewer shows it: patches drawn over the previous frame (disposal 1). */
function compositeGif(bytes: ArrayBuffer): ImageData[] {
  const parsed = parseGIF(bytes);
  const canvas = new OffscreenCanvas(parsed.lsd.width, parsed.lsd.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return decompressFrames(parsed, true).map((f) => {
    const patch = new OffscreenCanvas(f.dims.width, f.dims.height);
    patch.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height), 0, 0);
    ctx.drawImage(patch, f.dims.left, f.dims.top);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  });
}

/** Mean absolute RGB difference between two equally sized images. */
function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / ((a.length / 4) * 3);
}

/** Mean linear-light value of an opaque image's RGB channels. */
function linearMean(data: Uint8ClampedArray): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += lin(data[i]) + lin(data[i + 1]) + lin(data[i + 2]);
  return sum / ((data.length / 4) * 3);
}

/** Mean chroma (max − min channel) of an image: 0 for grey. */
function meanChroma(data: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
  return sum / (data.length / 4);
}

async function probeVideo(blob: Blob, thumbs = 2) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const videoDuration = await track.computeDuration();
    const firstTimestamp = await track.getFirstTimestamp();
    let decoded = 0;
    const timestamps: number[] = [];
    for await (const sample of new VideoSampleSink(track).samples()) {
      decoded++;
      timestamps.push(sample.timestamp);
      sample.close();
    }
    // Alpha of the top-left pixel of the first frame (transparent exports leave it at 0).
    const alphaSink = new CanvasSink(track, { alpha: true });
    const firstCanvas = (await alphaSink.getCanvas(firstTimestamp))?.canvas;
    const cornerAlpha = firstCanvas
      ? (firstCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).getImageData(0, 0, 1, 1).data[3]
      : null;
    const sink = new CanvasSink(track);
    const thumbnails: string[] = [];
    for (let k = 0; k < thumbs; k++) {
      const wrapped = await sink.getCanvas(firstTimestamp + ((k + 0.5) * videoDuration) / thumbs);
      if (wrapped) thumbnails.push(await canvasPng(wrapped.canvas));
    }
    return {
      mimeType: await input.getMimeType(),
      codec: track.codec,
      width: track.displayWidth,
      height: track.displayHeight,
      duration,
      videoDuration,
      firstTimestamp,
      decoded,
      timestamps,
      cornerAlpha,
      canBeTransparent: await track.canBeTransparent(),
      audioCodec: audio?.codec ?? null,
      audioDuration: audio ? await audio.computeDuration() : null,
      thumbnails,
    };
  } finally {
    input.dispose();
  }
}

/** A 2 s 320×180 H.264 clip with a stereo sine-wave track (none of the fixtures has audio). */
async function makeAvClip(audioCodec: 'aac' | 'opus', seconds = 2, fps = 30): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const canvas = new OffscreenCanvas(320, 180);
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('medium') });
  const audio = new AudioBufferSource({ codec: audioCodec, quality: new Quality('medium') });
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const n = seconds * fps;
  for (let i = 0; i < n; i++) {
    canvas.getContext('2d')!.drawImage(syntheticFrame(i, n), 0, 0);
    await video.add(i / fps, 1 / fps);
  }
  const sampleRate = 48000;
  const buffer = new AudioBuffer({ length: seconds * sampleRate, sampleRate, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin((2 * Math.PI * (440 + ch * 110) * i) / sampleRate);
  }
  await audio.add(buffer);
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

/** A synthetic H.264 MP4 drawn by `draw` (frame i of n). */
async function makeClip(spec: { seconds: number; fps: number; draw: (ctx: OffscreenCanvasRenderingContext2D, i: number, n: number) => void }): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const canvas = new OffscreenCanvas(320, 180);
  const ctx = canvas.getContext('2d')!;
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('medium') });
  output.addVideoTrack(video);
  await output.start();
  const n = Math.round(spec.seconds * spec.fps);
  for (let i = 0; i < n; i++) {
    spec.draw(ctx, i, n);
    await video.add(i / spec.fps, 1 / spec.fps);
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

/** Presentation timestamps of every frame in [start, end). */
async function frameTimestamps(blob: Blob, start = 0, end = Infinity): Promise<number[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const out: number[] = [];
    for await (const sample of new VideoSampleSink(track).samples()) {
      if (sample.timestamp >= start && sample.timestamp < end) out.push(sample.timestamp);
      sample.close();
    }
    return out;
  } finally {
    input.dispose();
  }
}

async function loadVideo(blob: Blob, name: string): Promise<LoadedVideo> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const stats = await track.computePacketStats();
  const durationSec = await input.computeDuration();
  const hasAudio = (await input.getPrimaryAudioTrack()) !== null;
  const element = document.createElement('video');
  element.muted = true;
  element.playsInline = true;
  element.preload = 'auto';
  element.src = URL.createObjectURL(blob);
  await new Promise((resolve) => element.addEventListener('loadeddata', resolve, { once: true }));
  const video: LoadedVideo = {
    kind: 'video',
    name,
    width: track.displayWidth,
    height: track.displayHeight,
    fileSize: blob.size,
    formatLabel: 'video',
    hasAlpha: false,
    element,
    file: blob,
    durationSec,
    fps: stats.averagePacketRate,
    hasAudio,
    codecLabel: track.codec ?? '',
    ...lifetimeMembers(() => URL.revokeObjectURL(element.src)),
  };
  input.dispose();
  return video;
}

function options(partial: Partial<ExportOptions>): ExportOptions {
  return {
    format: 'png',
    scale: 1,
    margin: 0,
    transparentBackground: false,
    lineEnding: '\n',
    svgText: 'outlines',
    includeAudio: true,
    ...partial,
  };
}

async function resultSummary(result: ExportResult) {
  return { fileName: result.fileName, width: result.width, height: result.height, warnings: result.warnings, size: result.blob.size, type: result.blob.type };
}

// ---------------------------------------------------------------------------------------------
// Font-accurate grid (real JetBrains Mono metrics) for vector-vs-raster comparisons

async function realGrid(cols: number, rows: number, seed = 7): Promise<GridSnapshot> {
  const face = new FontFace('JetBrains Mono', `url(${jetbrainsWoff2Url})`);
  document.fonts.add(await face.load());
  const ctx = new OffscreenCanvas(8, 8).getContext('2d')!;
  const geometry = computeGeometry(measureFontMetrics(ctx, '"JetBrains Mono"'), { lineHeight: 1.2, family: '"JetBrains Mono"', cellW: 10 });
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const chars = Array.from({ length: cols * rows }, () => String.fromCharCode(0x21 + Math.floor(rand() * 94)));
  return {
    cols,
    rows,
    chars,
    colors: new Uint8Array(cols * rows * 3),
    tone: new Float32Array(cols * rows),
    geometry,
    params: { ...DEFAULT_PARAMS, ink: '#000000', paper: '#ffffff', columns: cols },
  };
}

function referenceRaster(snap: GridSnapshot): OffscreenCanvas {
  const { cellW, cellH, baseline, fontSize } = snap.geometry;
  const c = new OffscreenCanvas(snap.cols * cellW, snap.rows * cellH);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = `${fontSize}px "JetBrains Mono"`;
  ctx.textBaseline = 'alphabetic';
  for (let r = 0; r < snap.rows; r++) {
    for (let col = 0; col < snap.cols; col++) ctx.fillText(snap.chars[r * snap.cols + col], col * cellW, r * cellH + baseline);
  }
  return c;
}

async function rasteriseSvg(svg: Blob, width: number, height: number): Promise<OffscreenCanvas> {
  const url = URL.createObjectURL(svg);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = new OffscreenCanvas(width, height);
    c.getContext('2d')!.drawImage(img, 0, 0, width, height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Zero-mean normalised cross-correlation (Pearson) of luminance between two rasters, with the
 * second shifted by -2..2 px. Stroke-weight differences (canvas text is hinted/smoothed) lower the
 * peak but do not move it, so a correct placement peaks at (0, 0).
 */
function alignment(a: OffscreenCanvas, b: OffscreenCanvas) {
  const w = a.width;
  const h = a.height;
  const luma = (c: OffscreenCanvas) => {
    const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    return out;
  };
  const la = luma(a);
  const lb = luma(b);
  const results: Record<string, number> = {};
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let n = 0;
      let sa = 0;
      let sb = 0;
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const p = la[y * w + x];
          const q = lb[(y + dy) * w + x + dx];
          n++;
          sa += p;
          sb += q;
          sab += p * q;
          saa += p * p;
          sbb += q * q;
        }
      }
      const cov = sab - (sa * sb) / n;
      const va = saa - (sa * sa) / n;
      const vb = sbb - (sb * sb) / n;
      results[`${dx},${dy}`] = cov / Math.sqrt(va * vb || 1);
    }
  }
  return results;
}

/** A real engine snapshot of a fixture image (CPU reference analysis) plus the engine's CPU raster of it. */
async function engineSnapshot(url: string, params: Partial<RenderParams>) {
  const p: RenderParams = { ...DEFAULT_PARAMS, columns: 72, autoLevels: false, ...params };
  await loadFont(p.font);
  const family = FONTS[p.font].family;
  const factory: CanvasFactory = (w, h) => {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) as unknown as GlyphContext };
  };
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const img = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ictx = img.getContext('2d')!;
  ictx.drawImage(bitmap, 0, 0);
  const image = { rgba: ictx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
  const measure = new OffscreenCanvas(8, 8).getContext('2d')!;
  const geometry = computeGeometry(measureFontMetrics(measure, family), { lineHeight: p.lineHeight, family });
  const taps = buildTapTables(analysisSize(gridSize(image.width, image.height, p.columns, geometry), geometry).sw, analysisSize(gridSize(image.width, image.height, p.columns, geometry), geometry).sh);
  const glyphs = buildGlyphSet(resolveCharset(p), geometry, factory, taps);
  const snapshot = toSnapshot(analyzeCpu(image, p, { black: 0, white: 1 }, geometry, glyphs, taps), glyphs, p, geometry);
  const raster = renderRasterCpu(snapshot, { scale: 1, margin: 0, transparentBackground: false }, factory).canvas as OffscreenCanvas;
  return { snapshot, raster };
}

// ---------------------------------------------------------------------------------------------
// Harness API (called by Playwright through page.evaluate)

/** The engine raster htmlVsEngine laid out last, for compareHtmlShot. */
let htmlReference: OffscreenCanvas | null = null;

const harness = {
  async png(scale: number, margin = 0, transparentBackground = false, targetWidth?: number) {
    const engine = new FakeEngine();
    engine.setSource(syntheticFrame(3, 10, 400, 225), { width: 400, height: 225, animated: false });
    const result = await exportPng(engine, { scale, margin, transparentBackground, targetWidth, sourceName: 'synthetic.png' });
    const bitmap = await createImageBitmap(result.blob);
    const { cols, rows } = engine.getGrid();
    const base = { width: cols * 8 + 2 * margin, height: rows * 17 + 2 * margin };
    // A resampled export against the exact-scale raster it was shrunk from: the same mean light (an
    // area average preserves it in linear light) and the same picture (it lines up with the
    // browser's own downscale, unshifted).
    let resample: { linearMean: number; sourceLinearMean: number; alignment: Record<string, number> } | null = null;
    if (targetWidth) {
      const source = engine.renderRaster({ scale: Math.ceil(targetWidth / base.width), margin, transparentBackground });
      const reference = new OffscreenCanvas(bitmap.width, bitmap.height);
      const rctx = reference.getContext('2d', { willReadFrequently: true })!;
      rctx.imageSmoothingQuality = 'high';
      rctx.drawImage(source, 0, 0, bitmap.width, bitmap.height);
      const out = new OffscreenCanvas(bitmap.width, bitmap.height);
      const octx = out.getContext('2d', { willReadFrequently: true })!;
      octx.drawImage(bitmap, 0, 0);
      resample = {
        linearMean: linearMean(octx.getImageData(0, 0, out.width, out.height).data),
        sourceLinearMean: linearMean(source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data),
        alignment: alignment(reference, out),
      };
    }
    return {
      ...(await resultSummary(result)),
      grid: { cols, rows },
      expected: targetWidth
        ? { width: targetWidth, height: Math.round((targetWidth * base.height) / base.width) }
        : { width: base.width * scale, height: base.height * scale },
      decoded: { width: bitmap.width, height: bitmap.height },
      resample,
      base64: await toBase64(result.blob),
    };
  },

  async pngTooLarge() {
    const engine = new FakeEngine({ maxRasterSize: 2048 });
    engine.setSource(syntheticFrame(0, 1), { width: 320, height: 180, animated: false });
    try {
      await exportPng(engine, { scale: 4, margin: 0, transparentBackground: false });
      return { error: null };
    } catch (e) {
      return { error: (e as Error).message, code: (e as { code?: string }).code };
    }
  },

  async gif(spec: {
    durations: number[];
    colorMode?: RenderParams['colorMode'];
    loopCount?: number;
    /** true: three frames; 'none': a sample source that yields nothing (e.g. undecodable times). */
    samples?: boolean | 'none';
    scale?: number;
    targetWidth?: number;
  }) {
    const engine = new FakeEngine({ params: { colorMode: spec.colorMode ?? 'mono', columns: 60 } });
    const progress: ExportProgress[] = [];
    const samples =
      spec.samples === 'none'
        ? []
        : spec.samples
          ? [0, 4, 8].map((i) => ({ source: syntheticFrame(i, spec.durations.length), info: { width: 320, height: 180, animated: true } }))
          : undefined;
    const started = performance.now();
    const result = await exportGif(
      engine,
      syntheticFrames(spec.durations),
      {
        scale: spec.scale ?? 1,
        targetWidth: spec.targetWidth,
        margin: 4,
        loopCount: spec.loopCount,
        frameCount: spec.durations.length,
        paletteSamples: samples,
        sourceName: 'synthetic.gif',
      },
      (p) => progress.push(p),
    );
    const ms = performance.now() - started;
    const bytes = await result.blob.arrayBuffer();
    // Each composited frame against the engine's own raster of that frame (palette error only).
    let maxFrameDiff = 0;
    if (!spec.targetWidth) {
      const frames = compositeGif(bytes);
      frames.forEach((frame, i) => {
        engine.setSource(syntheticFrame(i, spec.durations.length), { width: 320, height: 180, animated: true });
        const raster = engine.renderRaster({ scale: spec.scale ?? 1, margin: 4, transparentBackground: false });
        const expected = raster.getContext('2d')!.getImageData(0, 0, raster.width, raster.height).data;
        maxFrameDiff = Math.max(maxFrameDiff, meanAbsDiff(frame.data, expected));
      });
    }
    return {
      ...(await resultSummary(result)),
      ms,
      decoded: decodeGif(bytes),
      maxFrameDiff,
      progress: progress.map((p) => [p.fraction, p.label]),
      resets: engine.resets,
      base64: await toBase64(result.blob),
    };
  },

  /**
   * Video → GIF from a streaming WebM without cues: tests/media/fixtures/live_nocues.webm is
   * ffmpeg's testsrc2, 4 s at 25 fps, VP8, written with `-live 1` (unknown segment size, no Cues, rare
   * keyframes). Reports how many of the GIF's frame times Mediabunny's timestamp lookup could serve
   * (the old path), and what the export wrote.
   */
  async cuelessWebmGif() {
    const blob = await (await fetch('/tests/media/fixtures/live_nocues.webm')).blob();
    const video = await loadVideo(blob, 'live_nocues.webm');
    const fps = 25;
    const times = videoFrameTimes(video.durationSec, {}, fps);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    let servedByTimestamp = 0;
    for await (const c of new CanvasSink((await input.getPrimaryVideoTrack())!).canvasesAtTimestamps(times)) if (c) servedByTimestamp++;
    input.dispose();
    const engine = new FakeEngine({ params: { colorMode: 'mono', columns: 40 } });
    const result = await exportGif(engine, videoFrames(video, { fps }), { scale: 1, margin: 0, frameCount: times.length, sourceName: 'live_nocues.webm' });
    const decoded = decodeGif(await result.blob.arrayBuffer());
    // Distinct pictures: the moving ball makes every source frame different.
    const frames = compositeGif(await result.blob.arrayBuffer());
    let distinct = 1;
    for (let i = 1; i < frames.length; i++) if (meanAbsDiff(frames[i].data, frames[i - 1].data) > 0) distinct++;
    video.dispose();
    return { durationSec: video.durationSec, requested: times.length, servedByTimestamp, count: decoded.count, totalMs: decoded.delays.reduce((a, b) => a + b, 0), distinct, warnings: result.warnings };
  },

  /**
   * Video → GIF palette in source colour: a clip that is grey for 1 s and saturated
   * afterwards. With samples spread over the clip the late colour survives; sampling only the first
   * frames loses it.
   */
  async videoGifPalette() {
    const blob = await makeClip({
      seconds: 3,
      fps: 10,
      draw: (ctx, i) => {
        const late = i >= 10;
        ctx.fillStyle = late ? '#e02020' : '#808080';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = late ? '#20e040' : '#c0c0c0';
        ctx.fillRect(40 + i * 4, 40, 120, 100);
      },
    });
    const video = await loadVideo(blob, 'grey-then-colour.mp4');
    const run = async (withSamples: boolean) => {
      const engine = new FakeEngine({ params: { colorMode: 'source', columns: 40 } });
      const result = await exportGif(engine, videoFrames(video, { fps: 10 }), {
        scale: 1,
        margin: 0,
        frameCount: 30,
        paletteSamples: withSamples ? videoSamples(video) : undefined,
      });
      const frames = compositeGif(await result.blob.arrayBuffer());
      return { lastChroma: meanChroma(frames[frames.length - 1].data), count: frames.length };
    };
    const sampled = await run(true);
    const firstFramesOnly = await run(false);
    video.dispose();
    return { sampled, firstFramesOnly };
  },

  /**
   * A large animated GIF (2048², 12 frames: 16 MB per decoded frame, so the frame cache holds only 8)
   * exported in source colour with palette samples while the preview keeps pulling frames, as when
   * it plays during the export (the export's first frame was evicted and closed under it).
   */
  async bigGifSourceColour() {
    const side = 2048;
    const frames = 12;
    const palette = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 64) % 256]);
    const writer = new GifWriter(side, side, palette, 0);
    for (let f = 0; f < frames; f++) {
      const indices = new Uint8Array(side * side);
      for (let y = 0; y < side; y++) indices.fill((f + (y >> 7)) % 16, y * side, (y + 1) * side);
      writer.writeFrame(indices, { x: 0, y: 0, width: side, height: side }, { delayCs: 10, disposal: 1 });
    }
    const media = await loadMedia(new Blob([writer.finish()], { type: 'image/gif' }), 'big.gif');
    if (media.kind !== 'animation') throw new Error('expected an animation');
    let playing = true;
    let previewFrames = 0;
    const preview = (async () => {
      for (let i = 0; playing; i = (i + 1) % frames) {
        await media.getFrame(i);
        previewFrames++;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    try {
      const engine = new FakeEngine({ params: { colorMode: 'source', columns: 40 } });
      const result = await exportGif(engine, animationFrames(media), { scale: 1, margin: 0, frameCount: frames, paletteSamples: animationSamples(media) });
      return { count: decodeGif(await result.blob.arrayBuffer()).count, previewFrames };
    } finally {
      playing = false;
      await preview;
      media.dispose();
    }
  },

  /**
   * Opening or closing media mid-export: the media is disposed while a GIF and an
   * animation → MP4 export run; both finish with every frame, and the media is released afterwards.
   */
  async disposeDuringExport() {
    const load = async () => loadMedia(await (await fetch('/tests/fixtures/transparent_variable_duration.gif')).blob(), 'anim.gif');
    const results: Record<string, unknown> = {};
    for (const format of ['gif', 'mp4'] as const) {
      const media = await load();
      if (media.kind !== 'animation') throw new Error('expected an animation');
      const engine = new FakeEngine({ params: { columns: 40 } });
      let disposed = false;
      const onProgress = () => {
        if (!disposed) {
          disposed = true;
          media.dispose(); // what opening another file does
        }
      };
      const result =
        format === 'gif'
          ? await exportGif(engine, animationFrames(media), { scale: 1, margin: 0, frameCount: media.frameCount }, onProgress)
          : await exportVideo(engine, { kind: 'frames', frames: animationFrames(media), frameCount: media.frameCount }, options({ format: 'mp4' }), onProgress);
      let releasedAfter = false;
      try {
        await media.getFrame(0);
      } catch {
        releasedAfter = true;
      }
      results[format] = {
        disposedMidway: disposed,
        frames: format === 'gif' ? decodeGif(await result.blob.arrayBuffer()).count : (await probeVideo(result.blob, 0)).decoded,
        expected: media.frameCount,
        releasedAfter,
      };
    }
    return results;
  },

  /** GIF from a real GIF (media loader + animationFrames) and from a video (Mediabunny videoFrames). */
  async gifFromMedia(spec: { url: string; startSec?: number; endSec?: number; fps?: number; colorMode?: RenderParams['colorMode'] }) {
    const media = await loadMedia(await (await fetch(spec.url)).blob(), spec.url.split('/').pop());
    const engine = new FakeEngine({ params: { colorMode: spec.colorMode ?? 'mono', columns: 60 } });
    const range = { startSec: spec.startSec, endSec: spec.endSec };
    let frames: AsyncIterable<ExportFrame>;
    let frameCount: number;
    let expectedDelays: number[];
    let loopCount = 0;
    let paletteSamples;
    if (media.kind === 'animation') {
      const spans = animationSpans(media.durations, range);
      frames = animationFrames(media, range);
      frameCount = spans.length;
      expectedDelays = spans.map(([, ms]) => ms);
      loopCount = gifRepeatCount(media.loopCount);
      paletteSamples = animationSamples(media, range);
    } else if (media.kind === 'video') {
      const fps = gifFps(media.fps, spec.fps);
      const times = videoFrameTimes(media.durationSec, range, fps);
      frames = videoFrames(media, { ...range, fps });
      frameCount = times.length;
      expectedDelays = times.map(() => 1000 / fps);
    } else {
      throw new Error('expected an animation or a video');
    }
    const result = await exportGif(engine, frames, { scale: 1, margin: 0, frameCount, loopCount, paletteSamples, sourceName: media.name });
    media.dispose();
    return {
      ...(await resultSummary(result)),
      kind: media.kind,
      expectedDelays,
      sourceLoop: loopCount,
      decoded: decodeGif(await result.blob.arrayBuffer()),
      base64: await toBase64(result.blob),
    };
  },

  async gifCancel() {
    const engine = new FakeEngine({ params: { columns: 120 } });
    const controller = new AbortController();
    let seen = 0;
    try {
      await exportGif(engine, syntheticFrames(new Array(400).fill(40)), { scale: 2, margin: 0, frameCount: 400 }, () => {
        if (++seen === 3) controller.abort();
      }, controller.signal);
      return { aborted: false, seen };
    } catch (e) {
      return { aborted: isAbortError(e), seen, message: (e as Error).message };
    }
  },

  async video(spec: { format: 'mp4' | 'webm'; durations: number[]; transparent?: boolean; scale?: number; targetWidth?: number; columns?: number }) {
    const engine = new FakeEngine({ params: { colorMode: 'source', columns: spec.columns ?? 80 } });
    const progress: ExportProgress[] = [];
    const result = await exportVideo(
      engine,
      { kind: 'frames', frames: syntheticFrames(spec.durations), frameCount: spec.durations.length },
      {
        ...options({ format: spec.format, scale: spec.scale ?? 1, targetWidth: spec.targetWidth, transparentBackground: spec.transparent ?? false }),
        sourceName: 'synthetic',
      },
      (p) => progress.push(p),
    );
    return {
      ...(await resultSummary(result)),
      progress: progress.slice(-2).map((p) => [p.fraction, p.label]),
      probe: await probeVideo(result.blob),
      base64: await toBase64(result.blob),
    };
  },

  async convert(spec: {
    url?: string;
    useFileInput?: boolean;
    synthAudio?: 'aac' | 'opus';
    format: 'mp4' | 'webm';
    startSec?: number;
    endSec?: number;
    includeAudio?: boolean;
    columns?: number;
    scale?: number;
    compareTimestamps?: boolean;
  }) {
    let blob: Blob;
    let name: string;
    if (spec.synthAudio) {
      blob = await makeAvClip(spec.synthAudio);
      name = `av-${spec.synthAudio}.mp4`;
    } else if (spec.useFileInput) {
      const file = (document.getElementById('file') as HTMLInputElement).files![0];
      blob = file;
      name = file.name;
    } else {
      blob = await (await fetch(spec.url!)).blob();
      name = spec.url!.split('/').pop()!;
    }
    const video = await loadVideo(blob, name);
    const engine = new FakeEngine({ params: { colorMode: 'source', columns: spec.columns ?? 100 } });
    const progress: ExportProgress[] = [];
    const started = performance.now();
    const result = await exportVideo(
      engine,
      video,
      {
        ...options({ format: spec.format, scale: spec.scale ?? 1, includeAudio: spec.includeAudio ?? true, startSec: spec.startSec, endSec: spec.endSec }),
      },
      (p) => progress.push(p),
    );
    const ms = performance.now() - started;
    video.dispose();
    let maxTimestampDelta: number | null = null;
    if (spec.compareTimestamps) {
      // Output frames must sit exactly where the source frames were (VFR kept), shifted by the trim start.
      const start = spec.startSec ?? 0;
      const src = await frameTimestamps(blob, start, spec.endSec ?? Infinity);
      const out = await frameTimestamps(result.blob);
      maxTimestampDelta = src.length === out.length ? Math.max(...src.map((t, i) => Math.abs(t - start - out[i]))) : Infinity;
    }
    return {
      ...(await resultSummary(result)),
      ms,
      maxTimestampDelta,
      source: { width: video.width, height: video.height, durationSec: video.durationSec, fps: video.fps, hasAudio: video.hasAudio },
      progress: progress.slice(-2).map((p) => [p.fraction, p.label, p.etaSec ?? null]),
      progressCount: progress.length,
      probe: await probeVideo(result.blob, 3),
      base64: await toBase64(result.blob),
    };
  },

  async convertCancel(url: string) {
    const video = await loadVideo(await (await fetch(url)).blob(), 'cancel.mp4');
    const engine = new FakeEngine({ params: { columns: 100 } });
    const controller = new AbortController();
    let seen = 0;
    try {
      await exportVideo(engine, video, options({ format: 'mp4' }), () => {
        if (++seen === 5) controller.abort();
      }, controller.signal);
      return { aborted: false, seen };
    } catch (e) {
      return { aborted: isAbortError(e), seen, message: (e as Error).message };
    }
  },

  async realtime(spec: { useVideo?: boolean; url?: string }) {
    const saved = window.VideoEncoder;
    delete (window as { VideoEncoder?: unknown }).VideoEncoder;
    try {
      const engine = new FakeEngine({ params: { colorMode: 'source', columns: 60 } });
      const input = spec.useVideo
        ? await loadVideo(await (await fetch(spec.url!)).blob(), 'realtime.mp4')
        : { kind: 'frames' as const, frames: syntheticFrames(new Array(20).fill(50)), frameCount: 20 };
      const result = await exportVideo(engine, input, { ...options({ format: 'webm', startSec: 0, endSec: 1 }) });
      return { ...(await resultSummary(result)), base64: await toBase64(result.blob) };
    } finally {
      window.VideoEncoder = saved;
    }
  },

  async estimate(format: ExportOptions['format'], extra: Partial<ExportOptions> = {}, maxRasterSize?: number) {
    const engine = new FakeEngine({ maxRasterSize });
    engine.setSource(syntheticFrame(0, 1, 1920, 1080), { width: 1920, height: 1080, animated: false });
    return estimateExport(engine, { kind: 'video', durationSec: 4, fps: 30 }, options({ format, ...extra }));
  },

  /**
   * Records the (fake) camera through the engine for `ms` (needs --use-fake-device-for-media-stream):
   * real-time capture at the export size, start/stop with elapsed time and a final file.
   */
  async record(spec: { ms: number; format: 'mp4' | 'webm'; scale?: number; targetWidth?: number }) {
    const camera = await openCamera();
    const engine = new FakeEngine({ params: { colorMode: 'source', columns: 60 } });
    engine.setSource(camera.element, { width: camera.width, height: camera.height, animated: true });
    await camera.element.play();
    const recording = startRecording(engine, camera, { format: spec.format, scale: spec.scale ?? 1, targetWidth: spec.targetWidth, margin: 0, transparentBackground: false, sourceName: 'camera' });
    const midway: { elapsedSec: number; frames: number; state: string }[] = [];
    await new Promise((resolve) => setTimeout(resolve, spec.ms / 2));
    midway.push({ elapsedSec: recording.elapsedSec, frames: recording.frames, state: recording.state });
    await new Promise((resolve) => setTimeout(resolve, spec.ms / 2));
    const result = await recording.stop();
    const after = { elapsedSec: recording.elapsedSec, frames: recording.frames, state: recording.state };
    const tracksBefore = (camera.element.srcObject as MediaStream).getTracks().map((t) => t.readyState);
    const stream = camera.element.srcObject as MediaStream;
    camera.dispose();
    return {
      camera: { width: camera.width, height: camera.height, live: camera.live, durationSec: camera.durationSec },
      plannedSize: { width: recording.width, height: recording.height },
      container: recording.container,
      midway,
      after,
      result: await resultSummary(result),
      probe: await probeVideo(result.blob, 1),
      tracksBefore,
      tracksAfterDispose: stream.getTracks().map((t) => t.readyState),
      base64: await toBase64(result.blob),
    };
  },

  /**
   * The estimate's byte figures against the real files for the same settings, on content like ASCII
   * video: a static scene with one moving element.
   */
  async estimateVsActual() {
    const engine = new FakeEngine({ params: { colorMode: 'mono', columns: 80 } });
    const scene = (i: number) => {
      const c = syntheticFrame(0, 1);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(20 + i * 6, 120, 40, 30);
      return c;
    };
    const info = { width: 320, height: 180, animated: true };
    const media = { kind: 'animation' as const, durations: new Array(30).fill(40) };
    async function* frames(): AsyncGenerator<ExportFrame> {
      for (let i = 0; i < 30; i++) yield { source: scene(i), info, durationMs: 40 };
    }
    const out: Record<string, { estimate: number | undefined; actual: number }> = {};
    for (const scale of [1, 2]) {
      engine.setSource(scene(0), info);
      const png = await exportPng(engine, { scale, margin: 0, transparentBackground: false });
      out[`png-${scale}x`] = { estimate: (await estimateExport(engine, media, options({ format: 'png', scale }))).bytes, actual: png.blob.size };
      const gifEstimate = (await estimateExport(engine, media, options({ format: 'gif', scale }))).bytes;
      const gif = await exportGif(engine, frames(), { scale, margin: 0, frameCount: 30 });
      out[`gif-${scale}x`] = { estimate: gifEstimate, actual: gif.blob.size };
    }
    engine.setSource(scene(0), info);
    const txt = await estimateExport(engine, media, options({ format: 'txt' }));
    out.txt = { estimate: txt.bytes, actual: new TextEncoder().encode(engine.snapshot().chars.join('')).length + engine.getGrid().rows };
    return out;
  },

  /** Rasterises the SVG (outlines and text variants) and compares glyph placement with canvas fillText. */
  async svgVsCanvas() {
    const snap = await realGrid(48, 12);
    const reference = referenceRaster(snap);
    const fontBytes = new Uint8Array(await (await fetch(jetbrainsWoff2Url)).arrayBuffer());
    const font = { family: 'JetBrains Mono', data: fontBytes };
    const variant = async (svgText: 'outlines' | 'text') => {
      const result = await exportSvg(snap, { margin: 0, transparentBackground: false, svgText, font, sourceName: 'grid' });
      const text = await result.blob.text();
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      const raster = await rasteriseSvg(result.blob, reference.width, reference.height);
      return {
        parseError: parsed.getElementsByTagName('parsererror').length > 0,
        root: parsed.documentElement.nodeName,
        bytes: text.length,
        alignment: alignment(reference, raster),
        png: await canvasPng(raster),
        svg: text,
      };
    };
    return {
      geometry: snap.geometry,
      outlines: await variant('outlines'),
      text: await variant('text'),
      reference: await canvasPng(reference),
    };
  },

  /** SVG of a real engine snapshot vs the engine's own CPU raster of the same snapshot. */
  async svgVsEngine(params: Partial<RenderParams>) {
    const { snapshot, raster } = await engineSnapshot('/tests/fixtures/torus_450.png', params);
    const result = await exportSvg(snapshot, { margin: 0, transparentBackground: false, svgText: 'outlines', sourceName: 'torus' });
    const text = await result.blob.text();
    const svgRaster = await rasteriseSvg(result.blob, raster.width, raster.height);
    return {
      grid: { cols: snapshot.cols, rows: snapshot.rows },
      size: { width: raster.width, height: raster.height },
      svgSize: { width: result.width, height: result.height },
      parseError: new DOMParser().parseFromString(text, 'image/svg+xml').getElementsByTagName('parsererror').length > 0,
      bytes: text.length,
      warnings: result.warnings,
      alignment: alignment(raster, svgRaster),
      svgPng: await canvasPng(svgRaster),
      enginePng: await canvasPng(raster),
      svg: text,
    };
  },

  /**
   * The HTML export of a real engine snapshot, laid out in an iframe at the page's top-left corner at
   * exactly the raster's size, next to the engine's own raster of it. The spec screenshots the frame
   * and hands the pixels to compareHtmlShot.
   */
  async htmlVsEngine(params: Partial<RenderParams>) {
    const { snapshot, raster } = await engineSnapshot('/tests/fixtures/torus_450.png', { columns: 100, ...params });
    const html = await (await exportHtml(snapshot, { margin: 0, sourceName: 'torus' })).blob.text();
    document.querySelector('#html-frame')?.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'html-frame';
    Object.assign(iframe.style, { position: 'fixed', left: '0', top: '0', border: '0', width: `${raster.width + 40}px`, height: `${raster.height + 40}px`, zIndex: '10' });
    document.body.appendChild(iframe);
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = html;
    });
    const doc = iframe.contentDocument!;
    await doc.fonts.ready;
    const laidOut = (doc.querySelector('pre') ?? doc.querySelector('svg'))!.getBoundingClientRect();
    htmlReference = raster;
    return { size: { width: raster.width, height: raster.height }, laidOut: { width: laidOut.width, height: laidOut.height }, tag: doc.querySelector('pre') ? 'pre' : 'svg' };
  },

  /** Alignment (correlation at shifts of ±2 px) of a screenshot of the HTML frame against the engine raster. */
  async compareHtmlShot(pngBase64: string) {
    const reference = htmlReference;
    if (!reference) throw new Error('call htmlVsEngine first');
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${pngBase64}`)).blob());
    const shot = new OffscreenCanvas(reference.width, reference.height);
    shot.getContext('2d')!.drawImage(bitmap, 0, 0);
    document.querySelector('#html-frame')?.remove();
    return alignment(reference, shot);
  },

  /** Lays the HTML export out in an iframe and measures the <pre> against the cell geometry. */
  async htmlLayout() {
    const snap = await realGrid(64, 10);
    const fontBytes = new Uint8Array(await (await fetch(jetbrainsWoff2Url)).arrayBuffer());
    const html = snapshotToHtml(snap, { margin: 0, font: { family: 'JetBrains Mono', data: fontBytes } });
    const iframe = document.createElement('iframe');
    iframe.style.width = '1200px';
    iframe.style.height = '400px';
    document.body.appendChild(iframe);
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = html;
    });
    const doc = iframe.contentDocument!;
    await doc.fonts.ready;
    const pre = doc.querySelector('pre')!;
    const rect = pre.getBoundingClientRect();
    const loaded = [...doc.fonts].some((f) => f.family.replace(/"/g, '') === 'JetBrains Mono' && f.status === 'loaded');
    iframe.remove();
    // Default font embedding goes through the engine's FONTS registry.
    const viaWrapper = await exportHtml(snap, { margin: 0, sourceName: 'grid.png' });
    const embedsBundledFont = (await viaWrapper.blob.text()).includes(`base64,${btoa(String.fromCharCode(...fontBytes.subarray(0, 48)))}`);
    return {
      width: rect.width,
      height: rect.height,
      expected: { width: snap.cols * snap.geometry.cellW, height: snap.rows * snap.geometry.cellH },
      fontLoaded: loaded,
      fileName: viaWrapper.fileName,
      embedsBundledFont,
      html,
    };
  },
};

declare global {
  interface Window {
    exportHarness: typeof harness;
  }
}
window.exportHarness = harness;
document.getElementById('log')!.textContent = 'harness ready';
