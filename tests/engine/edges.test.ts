import { describe, expect, it } from 'vitest';
import type { RenderParams } from '../../src/engine/types';
import { analyzeCpu, createHistory, toSnapshot, type CpuImage } from '../../src/engine/cpu';
import { dogPlane, edgeKernels, edgeSetup } from '../../src/engine/edges';
import { EDGE_STROKES } from '../../src/engine/charsets';
import { IDENTITY_LEVELS, measureLevels } from '../../src/engine/tone';
import { fixturePath, loadRgba, params, pipeline } from './helpers';

const STROKES = new Set<string>(EDGE_STROKES);

/** 320 × 320 px: 40 columns of 8 × 16 cells, one image pixel per analysis pixel. */
const SIZE = 320;

/** A 2 px anti-aliased white line on black through (cx, cy) at `deg` (counter-clockwise from +x, y up). */
function lineImage(deg: number, cx = SIZE / 2, cy = SIZE / 2): CpuImage {
  const a = (deg * Math.PI) / 180;
  const nx = -Math.sin(a);
  const ny = -Math.cos(a); // image y points down
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.abs((x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny);
      const v = Math.round(255 * Math.min(1, Math.max(0, 1.5 - d)));
      rgba.set([v, v, v, 255], (y * SIZE + x) * 4);
    }
  }
  return { rgba, width: SIZE, height: SIZE };
}

function render(image: CpuImage, p: RenderParams) {
  const { geometry, glyphSet, taps } = pipeline(p);
  const result = analyzeCpu(image, p, IDENTITY_LEVELS, geometry, glyphSet, taps);
  return { snapshot: toSnapshot(result, glyphSet, p, geometry), geometry };
}

/** Strokes on the cells whose centre lies within `reach` px of the line (away from the image border). */
function strokesOnLine(deg: number, cx = SIZE / 2, cy = SIZE / 2, reach = 4) {
  const p = params({ columns: 40, edges: true, dither: 0, autoLevels: false });
  const { snapshot, geometry } = render(lineImage(deg, cx, cy), p);
  const a = (deg * Math.PI) / 180;
  const on: string[] = [];
  const elsewhere: string[] = [];
  for (let row = 1; row < snapshot.rows - 1; row++) {
    for (let col = 1; col < snapshot.cols - 1; col++) {
      const x = (col + 0.5) * geometry.cellW;
      const y = (row + 0.5) * geometry.cellH;
      const d = Math.abs(-(x - cx) * Math.sin(a) - (y - cy) * Math.cos(a));
      const ch = snapshot.chars[row * snapshot.cols + col];
      if (d <= reach) on.push(ch);
      else if (d > 12 && STROKES.has(ch)) elsewhere.push(ch);
    }
  }
  const share = (c: string) => on.filter((x) => x === c).length / on.length;
  return { on, elsewhere, share };
}

describe('§5b edge layer (CPU reference)', () => {
  it.each([
    [90, '|'],
    [45, '/'],
    [135, '\\'],
    [0, '-'],
  ])('a line at %i° becomes %s strokes', (deg, stroke) => {
    // Horizontal: centred in a cell row (y = 168 is row 10's centre), so '-' rather than '_'.
    const { on, elsewhere, share } = strokesOnLine(deg, SIZE / 2, deg === 0 ? 168 : SIZE / 2);
    expect(on.length).toBeGreaterThan(10);
    expect(share(stroke), `${deg}°: ${on.join('')}`).toBeGreaterThanOrEqual(0.8);
    expect(elsewhere, `${deg}°: strokes away from the line`).toEqual([]);
  });

  it('a horizontal edge low in the cell is "_"', () => {
    // y = 174 is 6 px below the centre of row 10 (160..176).
    const { share, on } = strokesOnLine(0, SIZE / 2, 174, 7);
    expect(share('_'), on.join('')).toBeGreaterThanOrEqual(0.8);
  });

  it('bins slopes by the cell aspect: in an 8 × 16 cell "/" rises at 63°', () => {
    // Lines steeper than the '/'–'|' boundary (77°) read '|'; between 32° and 77° '/'; flatter '-'.
    expect(strokesOnLine(70).share('/')).toBeGreaterThanOrEqual(0.8);
    expect(strokesOnLine(84).share('|')).toBeGreaterThanOrEqual(0.8);
    expect(strokesOnLine(40).share('/')).toBeGreaterThanOrEqual(0.8);
    const setup = edgeSetup(8, 16, 0.75, 0.5);
    expect((Math.atan(setup.tanSteep) * 180) / Math.PI).toBeCloseTo(13.28, 1);
    expect((Math.atan(setup.tanFlat) * 180) / Math.PI).toBeCloseTo(58.28, 1);
  });

  it('the difference of Gaussians ignores smooth shading and flat areas', () => {
    const { g1, g2, radius } = edgeKernels();
    const sum = (w: Float32Array) => w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
    expect(sum(g1)).toBeCloseTo(1, 6);
    expect(sum(g2)).toBeCloseTo(1, 6);
    const w = 64;
    const ramp = Float32Array.from({ length: w * w }, (_, i) => (i % w) / w);
    const D = dogPlane(ramp, w, w);
    // A linear ramp has no curvature: the band-pass response vanishes away from the clamped border.
    for (let y = radius; y < w - radius; y++) for (let x = radius; x < w - radius; x++) expect(Math.abs(D[y * w + x])).toBeLessThan(1e-6);
  });

  it('edges off leaves the render untouched; on, a cell is either its fill glyph or a stroke', async () => {
    const img = await loadRgba(fixturePath('torus_450.png'));
    const levels = measureLevels(img.rgba, img.width, img.height);
    for (const mode of ['shape', 'ramp'] as const) {
      const p = params({ mode, columns: 120 });
      const { geometry, glyphSet, taps } = pipeline(p);
      const off = analyzeCpu(img, { ...p, edges: false }, levels, geometry, glyphSet, taps).indices;
      const offAgain = analyzeCpu(img, { ...p, edges: false, edgeThreshold: 0.1 }, levels, geometry, glyphSet, taps).indices;
      expect(Buffer.from(offAgain.buffer).equals(Buffer.from(off.buffer))).toBe(true);
      const on = analyzeCpu(img, { ...p, edges: true }, levels, geometry, glyphSet, taps).indices;
      let strokes = 0;
      for (let i = 0; i < on.length; i++) {
        if (on[i] === off[i]) continue;
        expect(STROKES.has(glyphSet.atlasChars[on[i]])).toBe(true);
        strokes++;
      }
      // The torus outline: a ring of strokes, but nowhere near every cell.
      expect(strokes).toBeGreaterThan(60);
      expect(strokes / on.length).toBeLessThan(0.15);
    }
  });

  it('strokes are drawable with any charset: the minimal set gains them as extra atlas glyphs', () => {
    const p = params({ charsetPreset: 'minimal', edges: true, columns: 40, dither: 0, autoLevels: false });
    const { glyphSet } = pipeline(p);
    expect(glyphSet.chars).not.toContain('|');
    expect(EDGE_STROKES.map((c) => glyphSet.atlasChars[glyphSet.strokes[EDGE_STROKES.indexOf(c)]])).toEqual([...EDGE_STROKES]);
    const { snapshot } = render(lineImage(90), p);
    expect(snapshot.chars.filter((c) => c === '|').length).toBeGreaterThan(10);
  });

  it('a stroke survives sensor noise on video (§8 hysteresis)', () => {
    const p = params({ columns: 40, edges: true, dither: 0, autoLevels: false, stability: 1, edgeThreshold: 0.6 });
    const { geometry, glyphSet, taps } = pipeline(p);
    const base = lineImage(45);
    const frames = Array.from({ length: 6 }, (_, f) => {
      const rgba = new Uint8ClampedArray(base.rgba);
      let seed = 17 + f;
      for (let i = 0; i < rgba.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const n = ((seed >>> 16) % 41) - 20;
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.max(0, rgba[i + c] + n));
      }
      return { ...base, rgba };
    });
    const count = (idx: Uint16Array) => Array.from(idx).filter((g) => glyphSet.atlasChars[g] === '/').length;
    const plain = frames.map((f) => count(analyzeCpu(f, p, IDENTITY_LEVELS, geometry, glyphSet, taps).indices));
    const history = createHistory();
    const held = frames.map((f) => count(analyzeCpu(f, p, IDENTITY_LEVELS, geometry, glyphSet, taps, { history }).indices));
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(held)).toBeLessThanOrEqual(spread(plain));
    expect(Math.min(...held)).toBeGreaterThan(10);
  });
});
