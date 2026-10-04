// Node-side fixtures for engine tests: bundled fonts registered with @napi-rs/canvas, a canvas
// factory, PNG decoding and a one-call pipeline setup.
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import type { CellGeometry, FontId, RenderParams } from '../../src/engine/types';
import { DEFAULT_PARAMS } from '../../src/engine/types';
import { FONTS } from '../../src/engine/fonts';
import type { CanvasFactory } from '../../src/engine/atlas';
import { computeGeometry, measureFontMetrics } from '../../src/engine/geometry';
import { prepareAnalysis, type AnalysisSetup } from '../../src/engine/setup';
import type { CpuImage } from '../../src/engine/cpu';

const root = fileURLToPath(new URL('../../', import.meta.url));

export const FONT_IDS: FontId[] = ['jetbrains-mono', 'ibm-plex-mono', 'geist-mono'];

let registered = false;
export function registerFonts(): void {
  if (registered) return;
  for (const id of FONT_IDS) {
    const path = `${root}node_modules/@fontsource/${id}/files/${id}-latin-400-normal.woff2`;
    if (!GlobalFonts.registerFromPath(path, FONTS[id].name)) throw new Error(`could not register ${path}`);
  }
  registered = true;
}

export const factory: CanvasFactory = (w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
};

export function fixturePath(name: string): string {
  return `${root}tests/fixtures/${name}`;
}

export async function loadRgba(path: string): Promise<CpuImage> {
  const img = await loadImage(path);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { rgba: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
}

export function params(overrides: Partial<RenderParams> = {}): RenderParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}

export function geometryFor(font: FontId, lineHeight: number, cellW = 8): CellGeometry {
  registerFonts();
  return computeGeometry(measureFontMetrics(factory(1, 1).ctx, FONTS[font].family), { cellW, lineHeight, family: FONTS[font].family });
}

const setups = new Map<string, AnalysisSetup>();

/** Geometry, tap tables and glyph set for params (cached: glyph sets are the slow part). */
export function pipeline(p: RenderParams): AnalysisSetup {
  const key = `${p.font}|${p.lineHeight}|${p.charsetPreset}|${p.customCharset}`;
  let setup = setups.get(key);
  if (!setup) {
    registerFonts();
    setup = prepareAnalysis(p, FONTS[p.font].family, factory);
    setups.set(key, setup);
  }
  return setup;
}
