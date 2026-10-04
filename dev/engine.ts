/**
 * Dev harness for the WebGL2 engine (src/engine/gl): a live preview with plain controls and a
 * timing readout, plus the checks tests/e2e/engine.spec.ts drives through `window.engineHarness`:
 *   - GPU vs the CPU reference, glyph for glyph: fed the GPU's own analysis image (must match),
 *     and end to end from the source pixels (reported, with the residuals explained)
 *   - exact raster sizes, preview = export at integer zoom, context loss / restore, the CPU
 *     fallback engine, GPU-synchronised timings and real-time video playback
 *   - readRaster, probe, getTimings, warmup, releaseSource, compare with ramp, the minified preview
 */
import { DEFAULT_PARAMS, type GridSnapshot, type Levels, type RenderParams, type Viewport } from '../src/engine/types';
import { GlEngine, type FrameProfile } from '../src/engine/gl/renderer';
import { CpuEngine } from '../src/engine/gl/fallback';
import { measureFrameLevels } from '../src/engine/gl/levels';
import { analysisLightness, analyzeCpu, createHistory, sampleCells, toSnapshot, type CpuImage } from '../src/engine/cpu';
import { resampleRgbaPremultiplied } from '../src/engine/resample';
import { IDENTITY_LEVELS, toneConstants } from '../src/engine/tone';
import { analysisSize, rasterSize } from '../src/engine/geometry';
import { hexLuma, parseHexColor } from '../src/engine/color';
import { AFFECTS, buildRectTaps } from '../src/engine/layout';
import { threshold, toneDither, toneNoise } from '../src/engine/dither';
import { createQuery, glyphDistance, prepareQuery } from '../src/engine/match';
import { BRAILLE_BITS, QUADRANT_CHARS } from '../src/engine/charsets';

const FIXTURES = [
  'torus_450.png',
  'terrain_640x360.png',
  'waves_600x400.png',
  'lineart_600x300.png',
  'gradient_512x64.png',
  'logo_rgba_256.png',
  'exif6_480x270.jpg',
  'gray16_200.png',
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const stats = $<HTMLDivElement>('stats');
const results = $<HTMLPreElement>('results');

const engine = GlEngine.create();
stage.append(engine.canvas);
const GPU_NAME = engine.gpuInfo().renderer;

let params: RenderParams = { ...DEFAULT_PARAMS };
let levels: Levels = { ...IDENTITY_LEVELS };
let still: ImageBitmap | null = null;
let video: HTMLVideoElement | null = null;
let zoom: Viewport['zoom'] = 'fit';
let compare: number | null = null;
let compareWith: Viewport['compareWith'] = 'source';
let showSource = false;
let dirty = true;
let loopPaused = false;
let lastMs = 0;

function viewport(overrides: Partial<Viewport> = {}): Viewport {
  const r = stage.getBoundingClientRect();
  return {
    width: Math.max(1, r.width),
    height: Math.max(1, r.height),
    devicePixelRatio: window.devicePixelRatio || 1,
    zoom,
    panX: 0,
    panY: 0,
    compare,
    compareWith,
    showSource,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------------
// Sources

function stopVideo(): void {
  if (!video) return;
  video.pause();
  URL.revokeObjectURL(video.src);
  video = null;
}

function setStill(bitmap: ImageBitmap): { width: number; height: number } {
  stopVideo();
  if (still !== bitmap) still?.close();
  still = bitmap;
  engine.setSource(bitmap, { width: bitmap.width, height: bitmap.height, animated: false });
  levels = measureFrameLevels([bitmap]);
  engine.setLevels(levels);
  dirty = true;
  return { width: bitmap.width, height: bitmap.height };
}

async function loadBlob(blob: Blob): Promise<{ width: number; height: number }> {
  if (blob.type.startsWith('video/')) return loadVideo(blob);
  return setStill(await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' }));
}

async function loadFixture(name: string): Promise<{ width: number; height: number }> {
  const res = await fetch(`/tests/fixtures/${name}`);
  if (!res.ok) throw new Error(`Fixture ${name}: HTTP ${res.status}`);
  return loadBlob(await res.blob());
}

async function loadVideo(blob: Blob): Promise<{ width: number; height: number }> {
  stopVideo();
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.loop = true;
  v.src = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error(`Video failed to load: ${v.error?.message ?? 'unknown error'}`));
  });
  video = v;
  levels = measureFrameLevels([v]);
  engine.setLevels(levels);
  engine.resetHistory();
  const info = { width: v.videoWidth, height: v.videoHeight, animated: true };
  // At 'loadeddata' the first frame may not be uploadable yet; it is once it has been presented.
  let presented: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => (presented = resolve));
  const onFrame = () => {
    if (video !== v) return;
    engine.setSource(v, info);
    dirty = true;
    presented();
    v.requestVideoFrameCallback(onFrame);
  };
  engine.setSource(v, info);
  v.requestVideoFrameCallback(onFrame);
  await Promise.race([firstFrame, new Promise((r) => setTimeout(r, 2000))]);
  return { width: v.videoWidth, height: v.videoHeight };
}

async function setParams(patch: Partial<RenderParams>): Promise<void> {
  params = { ...params, ...patch };
  await engine.setParams(params);
  syncControls();
  dirty = true;
}

// ------------------------------------------------------------------------------------------------
// GPU vs CPU reference

export interface CompareReport {
  mode: string;
  variant: string;
  cols: number;
  rows: number;
  cells: number;
  /** CPU fed the GPU's own analysis image (pass 1 output): must agree glyph for glyph. */
  fedMismatch: number;
  /** Of those, how many are float near-ties (relative distance gap < 1e-4 or a threshold margin < 1e-5). */
  fedNearTies: number;
  /** Largest gap among fed mismatches (relative for shape, absolute otherwise). */
  fedMaxGap: number;
  /** CPU reference from the source pixels (the GPU's own level-0 texels). */
  e2eMismatch: number;
  /** Blocks colour: end-to-end mismatches whose CPU scores differ by < 1e-6 (fit error or side tone). */
  e2eNearTies: number;
  e2eMaxGap: number;
  /** max |L_gpu − L_cpu| over the analysis image. */
  maxLightnessDiff: number;
  maxToneDiff: number;
  maxColourDiff: number;
  /** Fraction of colour channels within ±1 of the CPU reference. */
  colourWithin1: number;
}

function mismatches(a: GridSnapshot, b: GridSnapshot): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.chars.length; i++) if (a.chars[i] !== b.chars[i]) out.push(i);
  return out;
}

/** §5 sharpen + dither, as in cpu.ts, for the near-tie diagnosis of shape mismatches. */
function shapeFeatures(circles: Float64Array, cell: number, col: number, row: number, p: RenderParams): Float64Array {
  const q = Float64Array.from({ length: 6 }, (_, k) => circles[cell * 16 + k]);
  const e = Float64Array.from({ length: 10 }, (_, j) => circles[cell * 16 + 6 + j]);
  if (p.shapeSharpness !== 1) {
    const m = Math.max(...q);
    if (m > 0) for (let k = 0; k < 6; k++) q[k] = Math.pow(q[k] / m, p.shapeSharpness) * m;
  }
  if (p.edgeSharpness !== 1) {
    for (let k = 0; k < 6; k++) {
      let m = q[k];
      for (const j of AFFECTS[k]) m = Math.max(m, e[j]);
      if (m > 0) q[k] = Math.pow(q[k] / m, p.edgeSharpness) * m;
    }
  }
  const noise = toneNoise(col, row);
  for (let k = 0; k < 6; k++) q[k] = toneDither(q[k], noise, p.dither);
  return q;
}

/** Two-colour fit error of a quadrant partition (complement-invariant), as in cpu.ts fitTwoColours. */
function fitError(quad: number[][], bits: number): number {
  let e = 0;
  for (const want of [0, 1]) {
    const members = [0, 1, 2, 3].filter((i) => ((bits >> i) & 1) === want);
    if (!members.length) continue;
    const mean = [0, 1, 2].map((c) => members.reduce((s, i) => s + quad[i][c], 0) / members.length);
    for (const i of members) for (let c = 0; c < 3; c++) e += (quad[i][c] - mean[c]) ** 2;
  }
  return e;
}

/** |mean tone of the 'on' quadrants − mean tone of the others| (or of the cell vs 0.5 for one colour). */
function sideToneGap(tones: number[], bits: number): number {
  const on = tones.filter((_, i) => (bits >> i) & 1);
  const off = tones.filter((_, i) => !((bits >> i) & 1));
  if (!on.length || !off.length) return Math.abs(tones.reduce((a, b) => a + b, 0) / 4 - 0.5);
  return Math.abs(on.reduce((a, b) => a + b, 0) / on.length - off.reduce((a, b) => a + b, 0) / off.length);
}

/**
 * How close the CPU's own scores were for two blocks-colour answers: the same partition (or its
 * complement) was decided by the side tones, different partitions by their fit errors.
 */
function blocksGap(quad: number[][], tones: number[], a: number, b: number): number {
  const samePartition = a === b || a === 15 - b;
  return samePartition ? sideToneGap(tones, b) : Math.abs(fitError(quad, a) - fitError(quad, b));
}

function compareToCpu(variant = ''): CompareReport {
  const p = engine.currentParams()!;
  const setup = engine.glyphSetup();
  const { geometry, glyphSet, taps } = setup;
  const grid = engine.getGrid();
  const a = engine.readAnalysis();
  const size = analysisSize(grid, geometry);
  const blocksColour = p.mode === 'blocks' && p.colorMode === 'source';

  // CPU fed the GPU's analysis image: the lightness goes in as an opaque grey image with every
  // tone stage neutral, so the CPU's L equals the GPU's bit for bit. Pass 2 also reads the
  // quadrant colours (blocks' two-colour fit), so the GPU re-runs pass 2 on exactly the quadrant
  // colours the CPU derives from that same image.
  // Blocks colour also gets a smooth luma-neutral tint (0.2126·dr + 0.7152·dg + 0.0722·db = 0, so
  // the CPU's L is unchanged): with grey quadrants most partitions would tie exactly.
  const rgba = new Float64Array(a.width * a.height * 4);
  for (let i = 0; i < a.lightness.length; i++) {
    const v = a.lightness[i];
    let dr = 0;
    let db = 0;
    if (blocksColour && v > 1e-3) {
      const x = i % a.width;
      const y = Math.floor(i / a.width);
      dr = 0.05 * Math.sin(0.021 * x + 0.013 * y);
      db = 0.05 * Math.cos(0.017 * y - 0.009 * x);
    }
    const dg = -(0.2126 * dr + 0.0722 * db) / 0.7152;
    rgba[i * 4] = (v + dr) * 255;
    rgba[i * 4 + 1] = (v + dg) * 255;
    rgba[i * 4 + 2] = (v + db) * 255;
    rgba[i * 4 + 3] = 255;
  }
  const fedImage: CpuImage = { rgba, width: a.width, height: a.height };
  const fedParams: RenderParams = {
    ...p,
    columns: grid.cols,
    autoLevels: false,
    brightness: 0,
    contrast: 1,
    gamma: 1,
    invert: hexLuma(p.ink) < hexLuma(p.paper),
  };
  const fedQuads = resampleRgbaPremultiplied(rgba, a.width, a.height, grid.cols * 2, grid.rows * 2);
  const gpuFed = engine.analyseWithQuadColours(fedQuads);
  const fedResult = analyzeCpu(fedImage, fedParams, IDENTITY_LEVELS, geometry, glyphSet, taps);
  const fed = toSnapshot(fedResult, glyphSet, fedParams, geometry);
  const fedDiff = mismatches(gpuFed, fed);
  const gpu = engine.snapshot();

  // Near-tie diagnosis: how close the CPU's own scores were for the two choices.
  let nearTies = 0;
  let maxGap = 0;
  if (fedDiff.length) {
    const L = a.lightness;
    const tables = p.mode === 'shape' ? [...taps.internal, ...taps.external] : [];
    const circles = tables.length ? sampleCells(L, size, grid, tables) : null;
    const query = createQuery();
    for (const cell of fedDiff) {
      const col = cell % grid.cols;
      const row = Math.floor(cell / grid.cols);
      let gap = Infinity;
      let tie = false;
      if (p.mode === 'shape' && circles) {
        const q = shapeFeatures(circles, cell, col, row, p).map((v) => v * glyphSet.anchor);
        prepareQuery(q, query);
        const dCpu = glyphDistance(query, glyphSet, fedResult.indices[cell]);
        const dGpu = glyphDistance(query, glyphSet, glyphSet.chars.indexOf(gpuFed.chars[cell]));
        gap = (dGpu - dCpu) / Math.max(dCpu, 1e-12);
        tie = gap < 1e-4;
      } else if (p.mode === 'ramp') {
        const t = toneDither(fedResult.tone[cell], toneNoise(col, row), p.dither) * glyphSet.anchor;
        const cov = glyphSet.meanCoverage;
        gap = Math.abs(t - cov[glyphSet.chars.indexOf(gpuFed.chars[cell])]) - Math.abs(t - cov[fedResult.indices[cell]]);
        tie = gap < 1e-5;
      } else if (blocksColour) {
        const bits = (c: string) => QUADRANT_CHARS.indexOf(c);
        const quad = Array.from({ length: 4 }, (_, i) => {
          const o = ((row * 2 + (i >> 1)) * grid.cols * 2 + col * 2 + (i & 1)) * 4;
          return [fedQuads[o], fedQuads[o + 1], fedQuads[o + 2]];
        });
        const dots = sampleCells(L, size, grid, buildRectTaps(size.sw, size.sh, 2, 2));
        const tones = Array.from({ length: 4 }, (_, i) => dots[cell * 4 + i]);
        const gGpu = bits(gpuFed.chars[cell]);
        const gCpu = bits(fed.chars[cell]);
        gap = blocksGap(quad, tones, gGpu, gCpu);
        tie = gap < 1e-6;
      } else if (p.mode === 'halftone') {
        // Distance of 3·tone from the nearest rounding boundary of the ' ·•●' index.
        gap = Math.min(...[0.5, 1.5, 2.5].map((b) => Math.abs(fedResult.tone[cell] * 3 - b)));
        tie = gap < 1e-5;
      } else {
        // Braille / mono blocks: distance of the flipped dot's mean from its threshold.
        const braille = p.mode === 'braille';
        const ny = braille ? 4 : 2;
        const gpuBits = braille ? gpuFed.chars[cell].charCodeAt(0) - 0x2800 : QUADRANT_CHARS.indexOf(gpuFed.chars[cell]);
        const cpuBits = fedResult.indices[cell];
        const dots = sampleCells(L, size, grid, buildRectTaps(size.sw, size.sh, 2, ny));
        for (let i = 0; i < 2 * ny; i++) {
          const dx = i % 2;
          const dy = Math.floor(i / 2);
          const bit = braille ? BRAILLE_BITS[dy][dx] : 1 << i;
          if ((gpuBits & bit) === (cpuBits & bit)) continue;
          const v = dots[cell * 2 * ny + i];
          gap = Math.min(gap, Math.abs(v - threshold(p.ditherPattern, col * 2 + dx, row * ny + dy)));
        }
        tie = gap < 1e-5;
      }
      if (tie) nearTies++;
      maxGap = Math.max(maxGap, gap);
    }
  }

  // End to end: the CPU reference from the source texels.
  const src = engine.readSourcePixels();
  const srcImage: CpuImage = { rgba: src.rgba, width: src.width, height: src.height };
  const e2e = toSnapshot(analyzeCpu(srcImage, p, levels, geometry, glyphSet, taps), glyphSet, p, geometry);
  const cpuL = analysisLightness(srcImage, size, toneConstants(p, levels));
  const e2eDiff = mismatches(gpu, e2e);
  let e2eNearTies = 0;
  let e2eMaxGap = 0;
  if (blocksColour && e2eDiff.length) {
    // The CPU's own quadrant colours and tones: how far apart were its scores for the two answers?
    const paper = parseHexColor(p.paper).map((v) => v / 255);
    const quads = resampleRgbaPremultiplied(src.rgba, src.width, src.height, grid.cols * 2, grid.rows * 2);
    const dots = sampleCells(cpuL, size, grid, buildRectTaps(size.sw, size.sh, 2, 2));
    for (const cell of e2eDiff) {
      const col = cell % grid.cols;
      const row = Math.floor(cell / grid.cols);
      const quad = Array.from({ length: 4 }, (_, i) => {
        const o = ((row * 2 + (i >> 1)) * grid.cols * 2 + col * 2 + (i & 1)) * 4;
        return [0, 1, 2].map((c) => quads[o + c] + (1 - quads[o + 3]) * paper[c]);
      });
      const tones = Array.from({ length: 4 }, (_, i) => dots[cell * 4 + i]);
      const gap = blocksGap(quad, tones, QUADRANT_CHARS.indexOf(gpu.chars[cell]), QUADRANT_CHARS.indexOf(e2e.chars[cell]));
      if (gap < 1e-6) e2eNearTies++;
      e2eMaxGap = Math.max(e2eMaxGap, gap);
    }
  }
  let maxLightnessDiff = 0;
  for (let i = 0; i < cpuL.length; i++) maxLightnessDiff = Math.max(maxLightnessDiff, Math.abs(cpuL[i] - a.lightness[i]));
  let maxToneDiff = 0;
  for (let i = 0; i < e2e.tone.length; i++) maxToneDiff = Math.max(maxToneDiff, Math.abs(e2e.tone[i] - gpu.tone[i]));
  let maxColourDiff = 0;
  let within1 = 0;
  for (let i = 0; i < e2e.colors.length; i++) {
    const d = Math.abs(e2e.colors[i] - gpu.colors[i]);
    maxColourDiff = Math.max(maxColourDiff, d);
    if (d <= 1) within1++;
  }
  return {
    mode: p.mode,
    variant,
    cols: grid.cols,
    rows: grid.rows,
    cells: gpu.chars.length,
    fedMismatch: fedDiff.length,
    fedNearTies: nearTies,
    fedMaxGap: maxGap === Infinity ? -1 : maxGap,
    e2eMismatch: e2eDiff.length,
    e2eNearTies,
    e2eMaxGap,
    maxLightnessDiff,
    maxToneDiff,
    maxColourDiff,
    colourWithin1: within1 / e2e.colors.length,
  };
}

/**
 * `specialised`: pass 2 on the programs compiled for the current geometry (awaited, so they are
 * really used) or on the uniform-driven ones; both must reproduce the CPU reference.
 */
async function compareAll(fixtures: string[], variants: { name: string; params: Partial<RenderParams> }[], specialised = true): Promise<(CompareReport & { fixture: string })[]> {
  const out: (CompareReport & { fixture: string })[] = [];
  engine.specialisedPrograms = specialised;
  try {
    for (const fixture of fixtures) {
      await loadFixture(fixture);
      for (const v of variants) {
        await setParams({ ...DEFAULT_PARAMS, ...v.params });
        if (specialised) await engine.warmup();
        out.push({ fixture, ...compareToCpu(v.name) });
      }
    }
  } finally {
    engine.specialisedPrograms = true;
  }
  return out;
}

/**
 * §8 on a synthetic clip (the terrain panning 3 px per frame plus deterministic noise, so both the
 * smoothing and the pass-through of large changes are exercised): per frame, the GPU grid vs the
 * CPU reference run with one history object over the same frames.
 */
async function historyCheck(frames: number, patch: Partial<RenderParams>, specialised = true): Promise<{ frame: number; mismatch: number; cells: number }[]> {
  const bitmap = await createImageBitmap(await (await fetch('/tests/fixtures/terrain_640x360.png')).blob());
  const w = 480;
  const h = 270;
  engine.specialisedPrograms = specialised;
  await setParams({ ...DEFAULT_PARAMS, ...patch });
  if (specialised) await engine.warmup();
  const p = engine.currentParams()!;
  const { geometry, glyphSet, taps } = engine.glyphSetup();
  const cpuHistory = createHistory();
  const out: { frame: number; mismatch: number; cells: number }[] = [];
  const info = { width: w, height: h, animated: true };
  engine.resetHistory();
  for (let f = 0; f < frames; f++) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, -f * 3, 0, 640, 360);
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = ((((i >> 2) * 2654435761 + f * 40503) >>> 0) % 21) - 10;
      for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] + n));
    }
    ctx.putImageData(img, 0, 0);
    const frame = c.transferToImageBitmap();
    engine.setSource(frame, info);
    const gpu = engine.snapshot();
    const src = engine.readSourcePixels();
    const cpu = toSnapshot(analyzeCpu({ rgba: src.rgba, width: src.width, height: src.height }, p, levels, geometry, glyphSet, taps, { history: cpuHistory }), glyphSet, p, geometry);
    out.push({ frame: f, mismatch: mismatches(gpu, cpu).length, cells: gpu.chars.length });
    frame.close();
  }
  engine.specialisedPrograms = true;
  if (still) setStill(still);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Raster checks

interface RasterCheck {
  scale: number;
  margin: number;
  transparent: boolean;
  width: number;
  height: number;
  expectedWidth: number;
  expectedHeight: number;
}

function rasterChecks(): RasterCheck[] {
  const out: RasterCheck[] = [];
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  for (const scale of [1, 2, 4]) {
    for (const margin of [0, 3]) {
      const transparent = margin > 0;
      const c = engine.renderRaster({ scale, margin, transparentBackground: transparent });
      const expected = rasterSize(grid, geometry, { scale, margin });
      out.push({ scale, margin, transparent, width: c.width, height: c.height, expectedWidth: expected.width, expectedHeight: expected.height });
    }
  }
  return out;
}

function oversizedRasterError(): string {
  try {
    engine.renderRaster({ scale: Math.ceil(engine.maxRasterSize / (engine.getGrid().cols * engine.getGeometry().cellW)) + 1, transparentBackground: false });
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Preview at an integer zoom vs the export at that scale: pixels inside the grid must be identical.
 * With `transparent`, the preview (premultiplied in the canvas) must equal the transparent export
 * premultiplied, to rounding.
 */
async function previewVsExport(z: number, transparent = false): Promise<{ differing: number; pixels: number; exact: boolean }> {
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  const gw = grid.cols * geometry.cellW * z;
  const gh = grid.rows * geometry.cellH * z;
  const vp = viewport({ width: gw + 64, height: gh + 64, devicePixelRatio: 1, zoom: z, compare: null, showSource: false, transparentBackground: transparent });
  const preview = engine.readPreview(vp);
  const exported = (await engine.readRaster({ scale: z, margin: 0, transparentBackground: transparent })).data;
  const { originX, originY } = preview.layout;
  let differing = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = ((originY + y) * preview.width + originX + x) * 4;
      const j = (y * gw + x) * 4;
      const a = exported[j + 3];
      const tolerance = transparent ? 1 : 0;
      const same = [0, 1, 2].every((c) => Math.abs(preview.rgba[i + c] - Math.round((exported[j + c] * a) / 255)) <= tolerance) && preview.rgba[i + 3] === a;
      if (!same) differing++;
    }
  }
  dirty = true;
  return { differing, pixels: gw * gh, exact: preview.layout.exact };
}

// ------------------------------------------------------------------------------------------------
// Robustness

async function contextLossCheck(): Promise<{ before: number; renderedWhileLost: boolean; snapshotWhileLost: string; restoredEqual: boolean }> {
  const gl = engine.canvas.getContext('webgl2')!;
  const lose = gl.getExtension('WEBGL_lose_context')!;
  const before = engine.snapshot();
  const lost = new Promise((r) => engine.canvas.addEventListener('webglcontextlost', r, { once: true }));
  lose.loseContext();
  await lost;
  // Chrome allows restoreContext() only after the lost event has finished dispatching.
  await new Promise((r) => setTimeout(r, 0));
  let renderedWhileLost = true;
  try {
    engine.render(viewport());
  } catch {
    renderedWhileLost = false;
  }
  let snapshotWhileLost = '';
  try {
    engine.snapshot();
  } catch (e) {
    snapshotWhileLost = e instanceof Error ? e.message : String(e);
  }
  const restored = new Promise((r) => engine.canvas.addEventListener('webglcontextrestored', r, { once: true }));
  lose.restoreContext();
  await restored;
  engine.render(viewport());
  const after = engine.snapshot();
  dirty = true;
  return { before: before.chars.length, renderedWhileLost, snapshotWhileLost, restoredEqual: mismatches(before, after).length === 0 };
}

async function cpuFallbackCheck(): Promise<{ mismatchVsGpu: number; cells: number; sizes: [number, number][]; expected: [number, number][]; renderMs: number }> {
  if (!still) throw new Error('Load a still first');
  const cpu = new CpuEngine();
  await cpu.setParams(params);
  cpu.setSource(still, { width: still.width, height: still.height, animated: false });
  cpu.setLevels(levels);
  const t0 = performance.now();
  cpu.render(viewport());
  const renderMs = performance.now() - t0;
  const sizes: [number, number][] = [];
  const expected: [number, number][] = [];
  for (const scale of [1, 2]) {
    const c = cpu.renderRaster({ scale, margin: 2, transparentBackground: false });
    sizes.push([c.width, c.height]);
    const e = rasterSize(cpu.getGrid(), cpu.getGeometry(), { scale, margin: 2 });
    expected.push([e.width, e.height]);
  }
  const mismatch = mismatches(cpu.snapshot(), engine.snapshot()).length;
  const cells = engine.getGrid().cols * engine.getGrid().rows;
  cpu.dispose();
  return { mismatchVsGpu: mismatch, cells, sizes, expected, renderMs };
}

// ------------------------------------------------------------------------------------------------
// Performance

interface ProfileSummary {
  mode: string;
  cols: number;
  rows: number;
  canvas: [number, number];
  analysisMs: number;
  composeMs: number;
  totalMs: number;
  p95TotalMs: number;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * 0.95))];

/** A 1280 × 1408 still gives exactly 200 × 110 cells at 200 columns. */
async function loadPerfSource(): Promise<void> {
  const bitmap = await createImageBitmap(await (await fetch('/tests/fixtures/terrain_640x360.png')).blob());
  const c = new OffscreenCanvas(1280, 1408);
  c.getContext('2d')!.drawImage(bitmap, 0, 0, 1280, 1408);
  setStill(c.transferToImageBitmap());
}

/**
 * Median GPU-synchronised frame cost per mode. `warmupMs` of back-to-back frames first lets the
 * GPU leave its idle clocks (on Apple silicon a cold, bursty load measures 2–4× slower).
 */
function profileModes(modes: RenderParams['mode'][], runs: number, vp: Viewport, warmupMs = 0): ProfileSummary[] {
  const out: ProfileSummary[] = [];
  for (const mode of modes) {
    params = { ...params, mode };
    void engine.setParams(params);
    for (const t0 = performance.now(); performance.now() - t0 < warmupMs; ) engine.profile(vp);
    const samples: FrameProfile[] = [];
    for (let i = 0; i < runs + 3; i++) {
      const s = engine.profile(vp);
      if (i >= 3) samples.push(s);
    }
    const grid = engine.getGrid();
    out.push({
      mode,
      cols: grid.cols,
      rows: grid.rows,
      canvas: [engine.canvas.width, engine.canvas.height],
      analysisMs: median(samples.map((s) => s.analysisMs)),
      composeMs: median(samples.map((s) => s.composeMs)),
      totalMs: median(samples.map((s) => s.totalMs)),
      p95TotalMs: p95(samples.map((s) => s.totalMs)),
    });
  }
  dirty = true;
  return out;
}

interface PlaybackReport {
  width: number;
  height: number;
  seconds: number;
  /** Video frames presented by the element during the run (requestVideoFrameCallback). */
  videoFrames: number;
  /** Frames the engine analysed + composed (one per presented video frame). */
  renderedFrames: number;
  fps: number;
  videoFps: number;
  /** requestAnimationFrame rate while rendering every display frame. */
  rafFps: number;
  cpuMsMedian: number;
  cpuMsP95: number;
  /** GPU-synchronised upload + analysis + compose of one 720p frame (medians of 20, after a 1 s warm-up). */
  syncedFrameMs: number;
  uploadMs: number;
  analysisMs: number;
  composeMs: number;
  grid: [number, number];
  canvas: [number, number];
}

let pendingVideo: File | null = null;

async function playbackCheck(seconds: number): Promise<PlaybackReport> {
  const file = pendingVideo;
  if (!file) throw new Error('Choose a video first');
  loopPaused = true;
  stopVideo();
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.loop = true;
  v.src = URL.createObjectURL(file);
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error(`Video failed to load: ${v.error?.message ?? ''}`));
  });
  const info = { width: v.videoWidth, height: v.videoHeight, animated: true };
  levels = measureFrameLevels([v]);
  engine.setLevels(levels);
  engine.resetHistory();
  const vp = viewport();
  await v.play();

  // 1) One analysis + compose per presented video frame, as the app's player does.
  const cpuMs: number[] = [];
  let first = -1;
  let last = 0;
  let rendered = 0;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (first < 0) first = meta.presentedFrames;
      last = meta.presentedFrames;
      const t = performance.now();
      engine.setSource(v, info);
      engine.render(vp);
      cpuMs.push(performance.now() - t);
      rendered++;
      if (performance.now() - t0 < seconds * 1000) v.requestVideoFrameCallback(onFrame);
      else resolve();
    };
    v.requestVideoFrameCallback(onFrame);
  });
  const elapsed = (performance.now() - t0) / 1000;

  // 2) Render on every display frame (current video frame re-uploaded each time).
  let rafFrames = 0;
  const r0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      engine.setSource(v, info);
      engine.render(vp);
      rafFrames++;
      if (performance.now() - r0 < 2000) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const rafFps = rafFrames / ((performance.now() - r0) / 1000);

  // 3) GPU-synchronised cost of one frame: upload (+ mipmaps), analysis, compose.
  v.pause();
  const synced: number[] = [];
  const upload: number[] = [];
  const analysisMs: number[] = [];
  const composeMs: number[] = [];
  const gl = engine.canvas.getContext('webgl2')!;
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  for (const t0 = performance.now(); performance.now() - t0 < 1000; ) engine.profile(vp);
  for (let i = 0; i < 23; i++) {
    sync();
    const t0 = performance.now();
    engine.setSource(v, info);
    engine.waitForSourceUpload();
    const t1 = performance.now();
    const s = engine.profile(vp);
    if (i < 3) continue;
    upload.push(t1 - t0);
    analysisMs.push(s.analysisMs);
    composeMs.push(s.composeMs);
    synced.push(t1 - t0 + s.totalMs);
  }
  URL.revokeObjectURL(v.src);
  loopPaused = false;
  dirty = true;
  return {
    width: info.width,
    height: info.height,
    seconds: elapsed,
    videoFrames: last - first + 1,
    renderedFrames: rendered,
    fps: rendered / elapsed,
    videoFps: (last - first + 1) / elapsed,
    rafFps,
    cpuMsMedian: median(cpuMs),
    cpuMsP95: p95(cpuMs),
    syncedFrameMs: median(synced),
    uploadMs: median(upload),
    analysisMs: median(analysisMs),
    composeMs: median(composeMs),
    grid: [engine.getGrid().cols, engine.getGrid().rows],
    canvas: [engine.canvas.width, engine.canvas.height],
  };
}

// ------------------------------------------------------------------------------------------------
// readRaster, probe, timings, warmup, releaseSource, compare with ramp, minified preview

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** readRaster's pixels vs renderRaster's, byte for byte. */
async function readRasterCheck(cases: { scale: number; margin: number; transparent: boolean }[]): Promise<{ scale: number; width: number; height: number; differing: number; expected: [number, number] }[]> {
  const out = [];
  for (const c of cases) {
    const options = { scale: c.scale, margin: c.margin, transparentBackground: c.transparent };
    const pixels = await engine.readRaster(options);
    const canvas = engine.renderRaster(options) as OffscreenCanvas;
    const ref = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    // A 2D canvas stores premultiplied colour, so renderRaster's semi-transparent pixels come back
    // rounded (by up to 255 / 2a); readRaster returns the engine's straight values untouched.
    let differing = 0;
    const d = pixels.data;
    for (let i = 0; i < ref.length; i += 4) {
      const a = ref[i + 3];
      const tolerance = a === 255 ? 0 : a === 0 ? 255 : Math.ceil(255 / (2 * a)) + 1;
      const rgb = Math.max(Math.abs(ref[i] - d[i]), Math.abs(ref[i + 1] - d[i + 1]), Math.abs(ref[i + 2] - d[i + 2]));
      if (a !== d[i + 3] || rgb > tolerance) differing++;
    }
    const e = rasterSize(engine.getGrid(), engine.getGeometry(), { scale: c.scale, margin: c.margin });
    out.push({ scale: c.scale, width: pixels.width, height: pixels.height, differing, expected: [e.width, e.height] as [number, number] });
  }
  return out;
}

/** A readRaster while the picture changes between its batches must reject, not mix two pictures. */
/**
 * A readRaster large enough to be read in batches, with the picture changed while it reads: params
 * (columns and gamma: a new grid and a new analysis), or the source released (the file closed). The
 * result must be the picture at the call, byte for byte and fully opaque; a font,
 * charset or line-height change is the one change that rejects.
 */
async function readRasterChangeCheck(scale: number): Promise<{ change: string; differing: number; notOpaque: number; error: string | null }[]> {
  const options = { scale, transparentBackground: false };
  const reference = await engine.readRaster(options);
  const restore = async () => {
    await engine.setParams(params);
    engine.setSource(still!, { width: still!.width, height: still!.height, animated: false });
  };
  const changes: [string, () => Promise<void> | void][] = [
    ['params', () => engine.setParams({ ...params, columns: params.columns - 20, gamma: params.gamma + 0.1 })],
    ['releaseSource', () => engine.releaseSource()],
    ['lineHeight', () => engine.setParams({ ...params, lineHeight: params.lineHeight + 0.1 })],
  ];
  const out = [];
  for (const [change, apply] of changes) {
    const pending = engine.readRaster(options);
    await apply();
    try {
      const got = await pending;
      let differing = 0;
      let notOpaque = 0;
      for (let i = 0; i < got.data.length; i++) if (got.data[i] !== reference.data[i]) differing++;
      for (let i = 3; i < got.data.length; i += 4) if (got.data[i] !== 255) notOpaque++;
      if (got.width !== reference.width || got.height !== reference.height) differing = -1;
      out.push({ change, differing, notOpaque, error: null });
    } catch (e) {
      out.push({ change, differing: -1, notOpaque: -1, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await restore();
    }
  }
  dirty = true;
  return out;
}

/** probe() answers from an asynchronous readback: pending at first, then the snapshot's cells. */
async function probeCheck(): Promise<{ firstPending: boolean | null; frames: number; matches: number; checked: number; outside: unknown }> {
  void engine.setParams({ ...params, gamma: params.gamma * 1.01 });
  await engine.setParams(params);
  engine.render(viewport());
  const grid = engine.getGrid();
  const first = engine.probe(1, 1);
  let frames = 0;
  for (let p = engine.probe(1, 1); (!p || p.pending) && frames < 60; p = engine.probe(1, 1)) {
    await nextFrame();
    frames++;
  }
  const snap = engine.snapshot();
  let matches = 0;
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const col = (i * 37) % grid.cols;
    const row = (i * 11) % grid.rows;
    const p = engine.probe(col, row);
    checked++;
    if (p && !p.pending && p.char === snap.chars[row * grid.cols + col] && Math.abs(p.tone - snap.tone[row * grid.cols + col]) < 1e-6) matches++;
  }
  dirty = true;
  return { firstPending: first ? !!first.pending : null, frames, matches, checked, outside: engine.probe(grid.cols, 0) };
}

/** GPU time arrives a few frames after the render that produced it. */
async function timingsCheck(): Promise<{ gpuMs: number | null; cpuMs: number; timerQuery: boolean }> {
  for (let i = 0; i < 10; i++) {
    engine.resetHistory();
    engine.render(viewport());
    await nextFrame();
  }
  return { ...engine.getTimings(), timerQuery: engine.gpuInfo().timerQuery };
}

/** A fresh engine compiles every program in warmup(), so later renders in any mode compile nothing. */
async function warmupCheck(): Promise<{ compiledAfterWarmup: string[]; newAfterRenders: string[]; warmupMs: number; firstRenderMs: Record<string, number> }> {
  // Before params are set the geometry is unknown, so only geometry-independent programs warm up;
  // the specialised pass 2 then compiles in the background (allowed after renders, never blocking).
  const fresh = GlEngine.create();
  const t0 = performance.now();
  await fresh.warmup();
  const warmupMs = performance.now() - t0;
  const compiledAfterWarmup = fresh.compiledPrograms();
  await fresh.setParams(params);
  fresh.setSource(still!, { width: still!.width, height: still!.height, animated: false });
  const firstRenderMs: Record<string, number> = {};
  for (const mode of ['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const) {
    await fresh.setParams({ ...params, mode, edges: mode === 'shape' });
    const t = performance.now();
    fresh.render(viewport({ zoom: mode === 'ramp' ? 0.5 : 'fit', compare: 0.5, compareWith: 'ramp' }));
    firstRenderMs[mode] = performance.now() - t;
  }
  const newAfterRenders = fresh.compiledPrograms().filter((k) => !compiledAfterWarmup.includes(k));
  fresh.dispose();
  return { compiledAfterWarmup, newAfterRenders, warmupMs, firstRenderMs };
}

/** releaseSource frees source- and grid-sized GPU memory; the next setSource brings the picture back. */
async function releaseCheck(): Promise<{ before: unknown; after: unknown; gridAfter: unknown; restoredEqual: boolean }> {
  const fresh = GlEngine.create();
  await fresh.setParams({ ...params, edges: true });
  fresh.setSource(still!, { width: still!.width, height: still!.height, animated: false });
  fresh.render(viewport({ zoom: 0.5, compare: 0.5, compareWith: 'ramp' }));
  await fresh.readRaster({ scale: 1, transparentBackground: false });
  const reference = fresh.snapshot().chars.join('');
  const before = fresh.allocations();
  fresh.releaseSource();
  const after = fresh.allocations();
  const gridAfter = fresh.render(viewport());
  fresh.setSource(still!, { width: still!.width, height: still!.height, animated: false });
  fresh.render(viewport());
  const restoredEqual = fresh.snapshot().chars.join('') === reference;
  fresh.dispose();
  return { before, after, gridAfter, restoredEqual };
}

/**
 * Compare with ramp at an exact zoom: left of the split the preview equals the ramp render, right
 * of it the render itself (each checked against a plain preview of that mode).
 */
async function compareRampCheck(): Promise<{ leftDiffering: number; rightDiffering: number; pixels: number }> {
  const z = 1;
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  const vp = (o: Partial<Viewport>) => viewport({ width: grid.cols * geometry.cellW + 64, height: grid.rows * geometry.cellH + 64, devicePixelRatio: 1, zoom: z, showSource: false, ...o });
  const split = await (async () => {
    const shape = engine.readPreview(vp({ compare: null }));
    await engine.setParams({ ...params, mode: 'ramp', edges: false });
    const ramp = engine.readPreview(vp({ compare: null }));
    await engine.setParams(params);
    const both = engine.readPreview(vp({ compare: 0.5, compareWith: 'ramp' }));
    return { shape, ramp, both };
  })();
  const { width, height } = split.both;
  const cut = width / 2;
  let leftDiffering = 0;
  let rightDiffering = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const ref = x + 0.5 < cut ? split.ramp.rgba : split.shape.rgba;
      const same = ref[i] === split.both.rgba[i] && ref[i + 1] === split.both.rgba[i + 1] && ref[i + 2] === split.both.rgba[i + 2];
      if (!same) {
        if (x + 0.5 < cut) leftDiffering++;
        else rightDiffering++;
      }
    }
  }
  dirty = true;
  return { leftDiffering, rightDiffering, pixels: width * height };
}

/**
 * Below zoom 1 the preview is the 1× export box-filtered: compare a 0.5 preview with a 2 × 2 box
 * average of renderRaster at scale 1 (inside the grid).
 */
function minifiedCheck(): { maxDiff: number; meanDiff: number; zoom: number } {
  const grid = engine.getGrid();
  const geometry = engine.getGeometry();
  const gw = grid.cols * geometry.cellW;
  const gh = grid.rows * geometry.cellH;
  const preview = engine.readPreview(viewport({ width: gw / 2 + 64, height: gh / 2 + 64, devicePixelRatio: 1, zoom: 0.5, compare: null, showSource: false }));
  const raster = engine.renderRaster({ scale: 1, transparentBackground: false }) as OffscreenCanvas;
  const ref = raster.getContext('2d')!.getImageData(0, 0, gw, gh).data;
  const { originX, originY } = preview.layout;
  let maxDiff = 0;
  let total = 0;
  let n = 0;
  for (let y = 0; y < gh / 2; y++) {
    for (let x = 0; x < gw / 2; x++) {
      const px = originX + x;
      const py = originY + y;
      if (!Number.isInteger(px) || !Number.isInteger(py)) throw new Error('expected a whole-pixel origin');
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += ref[((2 * y + dy) * gw + 2 * x + dx) * 4 + c];
        const d = Math.abs(preview.rgba[(py * preview.width + px) * 4 + c] - s / 4);
        maxDiff = Math.max(maxDiff, d);
        total += d;
        n++;
      }
    }
  }
  dirty = true;
  return { maxDiff, meanDiff: total / n, zoom: preview.layout.zoom };
}

/** the CPU fallback's grid comes from the full source size, like the GPU's and the UI's. */
async function cpuGridCheck(width: number, height: number, columns: number, patch: Partial<RenderParams>): Promise<{ gpu: [number, number]; cpu: [number, number]; cpuRaster: [number, number]; gpuRaster: [number, number] }> {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#000');
  g.addColorStop(1, '#fff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  const bitmap = c.transferToImageBitmap();
  const p = { ...params, ...patch, columns };
  const gpu = GlEngine.create();
  const cpu = new CpuEngine();
  for (const e of [gpu, cpu]) {
    await e.setParams(p);
    e.setSource(bitmap, { width, height, animated: false });
  }
  const gGrid = gpu.getGrid();
  const cSnap = cpu.snapshot();
  const cRaster = await cpu.readRaster({ scale: 1, transparentBackground: false });
  const gRaster = await gpu.readRaster({ scale: 1, transparentBackground: false });
  gpu.dispose();
  cpu.dispose();
  bitmap.close();
  return { gpu: [gGrid.cols, gGrid.rows], cpu: [cSnap.cols, cSnap.rows], cpuRaster: [cRaster.width, cRaster.height], gpuRaster: [gRaster.width, gRaster.height] };
}

// ------------------------------------------------------------------------------------------------
// Images out

async function canvasBase64(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob = 'convertToBlob' in canvas ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function exportPng(scale: number, margin = 0, transparent = false): Promise<string> {
  return canvasBase64(engine.renderRaster({ scale, margin, transparentBackground: transparent }));
}

/** The preview as the user sees it (read back in the same task, so it works without preserveDrawingBuffer). */
function previewPng(overrides: Partial<Viewport> = {}): Promise<string> {
  const p = engine.readPreview(viewport(overrides));
  const c = new OffscreenCanvas(p.width, p.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
  dirty = true;
  return canvasBase64(c);
}

// ------------------------------------------------------------------------------------------------
// UI

const fixtureSelect = $<HTMLSelectElement>('fixture');
for (const f of FIXTURES) fixtureSelect.append(new Option(f, f));
fixtureSelect.onchange = () => void loadFixture(fixtureSelect.value).catch(report);

$<HTMLInputElement>('file').onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.type.startsWith('video/')) pendingVideo = file;
  // Scripted runs (tests/e2e) load the file themselves via loadChosenFile / playbackCheck.
  if (navigator.webdriver) return;
  void loadBlob(file)
    .then(() => video?.play())
    .catch(report);
};

const paramInputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]');
function syncControls(): void {
  for (const el of paramInputs) {
    const key = el.dataset.param as keyof RenderParams;
    const value = params[key];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = String(value);
  }
}
for (const el of paramInputs) {
  el.addEventListener('input', () => {
    const key = el.dataset.param as keyof RenderParams;
    const raw = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    const value = typeof DEFAULT_PARAMS[key] === 'number' ? Number(raw) : raw;
    void setParams({ [key]: value } as Partial<RenderParams>).catch(report);
  });
}
$<HTMLSelectElement>('zoom').onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  zoom = v === 'fit' ? 'fit' : Number(v);
  dirty = true;
};
$<HTMLInputElement>('compare').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  compare = v < 0 ? null : v;
  (e.target as HTMLInputElement).parentElement!.querySelector('output')!.textContent = compare === null ? 'off' : v.toFixed(2);
  dirty = true;
};
$<HTMLSelectElement>('compareWith').onchange = (e) => {
  compareWith = (e.target as HTMLSelectElement).value as Viewport['compareWith'];
  dirty = true;
};
$<HTMLInputElement>('showSource').onchange = (e) => {
  showSource = (e.target as HTMLInputElement).checked;
  dirty = true;
};
$<HTMLButtonElement>('cmp').onclick = () => {
  try {
    results.textContent = JSON.stringify(compareToCpu('ui'), null, 2);
  } catch (e) {
    report(e);
  }
};
$<HTMLButtonElement>('prof').onclick = () => {
  results.textContent = JSON.stringify({ gpu: engine.gpuInfo(), frames: profileModes([params.mode], 20, viewport(), 500) }, null, 2);
};
for (const s of [1, 2, 4]) {
  $<HTMLButtonElement>(`png${s}`).onclick = async () => {
    const canvas = engine.renderRaster({ scale: s, transparentBackground: false });
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ascii-${params.mode}-x${s}.png`;
    a.click();
  };
}
new ResizeObserver(() => (dirty = true)).observe(stage);

function report(e: unknown): void {
  results.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
}

function showStats(cols: number, rows: number): void {
  const { gpuMs, cpuMs } = engine.getTimings();
  const gpu = gpuMs === null ? 'GPU time n/a' : `${gpuMs.toFixed(2)} ms GPU`;
  stats.textContent = `${cols} × ${rows} cells · ${gpu} · ${cpuMs.toFixed(2)} ms CPU submit (avg ${lastMs.toFixed(2)}) · ${GPU_NAME}`;
}

function loop(): void {
  if (dirty && !loopPaused) {
    dirty = false;
    try {
      const s = engine.render(viewport());
      lastMs = lastMs * 0.9 + s.ms * 0.1;
      showStats(s.cols, s.rows);
      // GPU time arrives a few frames late; refresh the readout once it has.
      setTimeout(() => showStats(s.cols, s.rows), 100);
    } catch (e) {
      report(e);
    }
  }
  requestAnimationFrame(loop);
}

const ready = (async () => {
  void engine.warmup();
  syncControls();
  await setParams(params);
  await loadFixture(FIXTURES[0]);
  requestAnimationFrame(loop);
})();
ready.catch(report);

/** The current source's display size and grid. */
function sourceInfo(): { width: number; height: number; cols: number; rows: number } {
  const size = video ? { width: video.videoWidth, height: video.videoHeight } : { width: still?.width ?? 0, height: still?.height ?? 0 };
  return { ...size, ...engine.getGrid() };
}

/** Loads the file chosen in #file (stills and videos; a video is paused on its first frame). */
async function loadChosenFile(): Promise<{ width: number; height: number; cols: number; rows: number }> {
  const file = $<HTMLInputElement>('file').files?.[0];
  if (!file) throw new Error('No file chosen');
  await loadBlob(file);
  video?.pause();
  return sourceInfo();
}

const harness = {
  ready,
  engine,
  sourceInfo,
  loadChosenFile,
  gpuInfo: () => engine.gpuInfo(),
  loadFixture,
  setParams,
  render: () => engine.render(viewport()),
  compare: compareToCpu,
  compareAll,
  historyCheck,
  rasterChecks,
  oversizedRasterError,
  previewVsExport,
  contextLossCheck,
  cpuFallbackCheck,
  loadPerfSource,
  profileModes,
  playbackCheck,
  exportPng,
  previewPng,
  readRasterCheck,
  readRasterChangeCheck,
  probeCheck,
  timingsCheck,
  warmupCheck,
  releaseCheck,
  compareRampCheck,
  minifiedCheck,
  cpuGridCheck,
  setView: (v: { zoom?: Viewport['zoom']; compare?: number | null; compareWith?: Viewport['compareWith']; showSource?: boolean }) => {
    if (v.zoom !== undefined) zoom = v.zoom;
    if (v.compare !== undefined) compare = v.compare;
    if (v.compareWith !== undefined) compareWith = v.compareWith;
    if (v.showSource !== undefined) showSource = v.showSource;
    dirty = true;
  },
};

declare global {
  interface Window {
    engineHarness: typeof harness;
  }
}
window.engineHarness = harness;
