/**
 * Dev harness for the engine core (src/engine, CPU reference): runs the same checks as the Node
 * tests, but with the browser's own fonts, FontFace loading and Canvas2D rasteriser, and shows
 * the CPU raster of two fixtures. Exposes `window.engineCore` for tests/e2e/engine-core.spec.ts.
 */
import { DEFAULT_PARAMS, type FontId, type RenderParams } from '../src/engine/types';
import { FONTS, loadFont } from '../src/engine/fonts';
import { browserCanvasFactory } from '../src/engine/canvas';
import { prepareAnalysis, type AnalysisSetup } from '../src/engine/setup';
import { buildGlyphSet, drawGlyph } from '../src/engine/atlas';
import { resolveCharset } from '../src/engine/charsets';
import { analysisSize, gridSize } from '../src/engine/geometry';
import { analysisLightness, analyzeCpu, sampleCells, toSnapshot, type CpuImage } from '../src/engine/cpu';
import { nearestGlyph } from '../src/engine/match';
import { IDENTITY_LEVELS, measureLevels, toneConstants } from '../src/engine/tone';
import { renderRasterCpu } from '../src/engine/rasterCpu';

export interface FontReport {
  font: FontId;
  cellW: number;
  cellH: number;
  baseline: number;
  advanceEm: number;
  glyphs: number;
  dropped: string[];
  anchor: number;
  /** The FontFaceSet reports the face as available. */
  loaded: boolean;
  /** Sum of all glyph vector components: differs per font only if each font really drew the glyphs. */
  checksum: number;
  /** Normalised vectors of '-', '_' and '.'. */
  probes: Record<string, number[]>;
  roundTrip: number;
}

export interface FixtureReport {
  name: string;
  cols: number;
  rows: number;
  topGlyph: string;
  topShare: number;
  ms: number;
  rasterSize: [number, number];
  expectedRasterSize: [number, number];
  deterministic: boolean;
}

export interface EngineCoreReport {
  fonts: FontReport[];
  missing: { kept: string[]; dropped: string[] };
  fixtures: FixtureReport[];
  perfMs: number;
}

const params = (overrides: Partial<RenderParams> = {}): RenderParams => ({ ...DEFAULT_PARAMS, ...overrides });

function roundTrip(setup: AnalysisSetup): number {
  const { geometry, taps, glyphSet } = setup;
  const scale = 4;
  const cols = 40;
  const rows = 12;
  const cw = geometry.cellW * scale;
  const ch = geometry.cellH * scale;
  const { ctx } = browserCanvasFactory(cols * cw, rows * ch);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cols * cw, rows * ch);
  ctx.fillStyle = '#fff';
  const text = Array.from({ length: cols * rows }, (_, i) => glyphSet.chars[(i * 37 + 11) % glyphSet.chars.length]);
  text.forEach((c, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch + geometry.baseline * scale;
    drawGlyph(ctx, c, x, y, geometry.fontSize * scale, geometry.fontFamily);
  });
  const image = { rgba: ctx.getImageData(0, 0, cols * cw, rows * ch).data, width: cols * cw, height: rows * ch };
  const grid = gridSize(image.width, image.height, cols, geometry);
  const size = analysisSize(grid, geometry);
  const p = params({ autoLevels: false });
  const circles = sampleCells(analysisLightness(image, size, toneConstants(p, IDENTITY_LEVELS)), size, grid, taps.internal);
  const q = new Float64Array(6);
  let hits = 0;
  for (let cell = 0; cell < text.length; cell++) {
    for (let k = 0; k < 6; k++) q[k] = circles[cell * 6 + k] / glyphSet.componentMax[k];
    if (glyphSet.chars[nearestGlyph(q, glyphSet)] === text[cell]) hits++;
  }
  return hits / text.length;
}

async function loadFixture(name: string): Promise<CpuImage> {
  const blob = await (await fetch(`/tests/fixtures/${name}`)).blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { ctx } = browserCanvasFactory(bitmap.width, bitmap.height);
  (ctx as unknown as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0);
  return { rgba: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
}

function show(label: string, canvas: unknown): void {
  const figure = document.createElement('figure');
  const view = document.createElement('canvas');
  const source = canvas as OffscreenCanvas;
  view.width = source.width;
  view.height = source.height;
  view.getContext('2d')!.drawImage(source, 0, 0);
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  figure.append(view, caption);
  document.getElementById('out')!.append(figure);
}

async function run(): Promise<EngineCoreReport> {
  const fonts: FontReport[] = [];
  for (const font of Object.keys(FONTS) as FontId[]) {
    await loadFont(font);
    const setup = prepareAnalysis(params({ font }), FONTS[font].family, browserCanvasFactory);
    const { geometry, glyphSet } = setup;
    const probes: Record<string, number[]> = {};
    for (const c of ['-', '_', '.']) {
      const i = glyphSet.chars.indexOf(c);
      probes[c] = Array.from(glyphSet.vectors.subarray(i * 6, i * 6 + 6));
    }
    fonts.push({
      font,
      cellW: geometry.cellW,
      cellH: geometry.cellH,
      baseline: geometry.baseline,
      advanceEm: geometry.advanceEm,
      glyphs: glyphSet.chars.length,
      dropped: glyphSet.dropped,
      anchor: glyphSet.anchor,
      loaded: document.fonts.check(`16px ${FONTS[font].family}`),
      checksum: glyphSet.vectors.reduce((a, b) => a + b, 0),
      probes,
      roundTrip: roundTrip(setup),
    });
  }

  const base = prepareAnalysis(params(), FONTS['jetbrains-mono'].family, browserCanvasFactory);
  const custom = buildGlyphSet(
    resolveCharset({ charsetPreset: 'custom', customCharset: 'A中😀█⠿░·' }),
    base.geometry,
    browserCanvasFactory,
    base.taps,
  );

  const fixtures: FixtureReport[] = [];
  for (const name of ['torus_450.png', 'terrain_640x360.png']) {
    const image = await loadFixture(name);
    const levels = measureLevels(image.rgba, image.width, image.height);
    const p = params();
    const t0 = performance.now();
    const result = analyzeCpu(image, p, levels, base.geometry, base.glyphSet, base.taps);
    const ms = performance.now() - t0;
    const again = analyzeCpu(image, p, levels, base.geometry, base.glyphSet, base.taps);
    const snapshot = toSnapshot(result, base.glyphSet, p, base.geometry);
    const counts = new Map<string, number>();
    let inked = 0;
    for (const c of snapshot.chars) {
      if (c === ' ') continue;
      inked++;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const [topGlyph, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const raster = renderRasterCpu(snapshot, { scale: 1, margin: 0, transparentBackground: false }, browserCanvasFactory);
    show(`${name}: ${snapshot.cols}×${snapshot.rows}, ${ms.toFixed(1)} ms`, raster.canvas);
    fixtures.push({
      name,
      cols: snapshot.cols,
      rows: snapshot.rows,
      topGlyph,
      topShare: topCount / inked,
      ms,
      rasterSize: [(raster.canvas as OffscreenCanvas).width, (raster.canvas as OffscreenCanvas).height],
      expectedRasterSize: [snapshot.cols * base.geometry.cellW, snapshot.rows * base.geometry.cellH],
      deterministic: result.indices.every((v, i) => v === again.indices[i]),
    });
  }

  const W = 1280;
  const H = 1440;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 128 + 127 * Math.sin(i * 0.013) * Math.cos(i * 0.00007);
    rgba.set([v, v, v, 255], i * 4);
  }
  const perfImage = { rgba, width: W, height: H };
  const times: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    analyzeCpu(perfImage, params({ columns: 160 }), IDENTITY_LEVELS, base.geometry, base.glyphSet, base.taps);
    times.push(performance.now() - t0);
  }
  const perfMs = times.sort((a, b) => a - b)[3];

  return { fonts, missing: { kept: custom.chars, dropped: custom.dropped }, fixtures, perfMs };
}

const report = run();
report.then(
  (r) => {
    document.getElementById('status')!.textContent = JSON.stringify(r, (_, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 2);
  },
  (e: unknown) => {
    document.getElementById('status')!.textContent = `Failed: ${String(e)}`;
  },
);

declare global {
  interface Window {
    engineCore: Promise<EngineCoreReport>;
  }
}
window.engineCore = report;
