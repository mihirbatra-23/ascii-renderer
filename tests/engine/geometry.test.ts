import { describe, expect, it } from 'vitest';
import { analysisSize, gridSize, GRID_LIMITS, rasterSize } from '../../src/engine/geometry';
import { analyzeCpu, toSnapshot } from '../../src/engine/cpu';
import { renderRasterCpu } from '../../src/engine/rasterCpu';
import { IDENTITY_LEVELS } from '../../src/engine/tone';
import { factory, FONT_IDS, geometryFor, params, pipeline } from './helpers';

const SOURCES: [number, number][] = [
  [640, 360],
  [450, 450],
  [270, 480],
  [3000, 300],
];

describe('cell geometry (§1)', () => {
  it('measures real advances: every bundled font is 0.6 em, so lh 1.2 gives 8 × 16 cells', () => {
    for (const font of FONT_IDS) {
      const g = geometryFor(font, 1.2);
      expect(g.advanceEm).toBeCloseTo(0.6, 3);
      expect(g.cellW).toBe(8);
      expect(g.cellH).toBe(16);
      expect(g.fontSize * g.advanceEm).toBeCloseTo(g.cellW, 9);
      expect(analysisSize({ cols: 1, rows: 1 }, g)).toMatchObject({ sw: 8, sh: 16 });
    }
  });

  describe.each(FONT_IDS)('%s', (font) => {
    it.each([1.0, 1.2, 1.5])('lineHeight %s: aspect within 0.5/rows and exact raster sizes', (lh) => {
      const g = geometryFor(font, lh);
      expect(Number.isInteger(g.cellH)).toBe(true);
      expect(g.baseline).toBeGreaterThan(0);
      expect(g.baseline).toBeLessThanOrEqual(g.cellH);
      for (const [w, h] of SOURCES) {
        for (const cols of [40, 80, 160, 400]) {
          const grid = gridSize(w, h, cols, g);
          const srcAspect = h / w;
          const outAspect = (grid.rows * g.cellH) / (grid.cols * g.cellW);
          expect(Math.abs(srcAspect / outAspect - 1)).toBeLessThanOrEqual(0.5 / grid.rows + 1e-12);
          for (const scale of [1, 2, 4]) {
            const size = rasterSize(grid, g, { scale });
            expect(size).toEqual({ width: grid.cols * g.cellW * scale, height: grid.rows * g.cellH * scale });
            expect(rasterSize(grid, g, { scale, margin: 3 })).toEqual({
              width: (grid.cols * g.cellW + 6) * scale,
              height: (grid.rows * g.cellH + 6) * scale,
            });
          }
        }
      }
    });
  });

  it('the CPU raster is exactly cols·cellW·s × rows·cellH·s in every mode', () => {
    const rgba = new Uint8ClampedArray(320 * 180 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const image = { rgba, width: 320, height: 180 };
    for (const mode of ['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const) {
      const p = params({ mode, columns: 40 });
      const { geometry, taps, glyphSet } = pipeline(p);
      const snap = toSnapshot(analyzeCpu(image, p, IDENTITY_LEVELS, geometry, glyphSet, taps), glyphSet, p, geometry);
      for (const scale of [1, 2, 4]) {
        const r = renderRasterCpu(snap, { scale, margin: 0, transparentBackground: false }, factory);
        expect([r.width, r.height]).toEqual([snap.cols * geometry.cellW * scale, snap.rows * geometry.cellH * scale]);
        const canvas = r.canvas as { width: number; height: number };
        expect([canvas.width, canvas.height]).toEqual([r.width, r.height]);
      }
    }
  });
});

describe('grid limits', () => {
  const g = geometryFor('jetbrains-mono', 1.2);

  it('clamps the requested columns to 20..400', () => {
    expect(gridSize(640, 360, 5, g).cols).toBe(GRID_LIMITS.minCols);
    expect(gridSize(640, 360, 900, g).cols).toBe(GRID_LIMITS.maxCols);
  });

  it('reduces columns, not just rows, when rows or cells exceed the limits', () => {
    for (const [w, h] of [
      [300, 3000],
      [1080, 1920],
      [500, 20_000],
    ]) {
      const grid = gridSize(w, h, 400, g);
      expect(grid.rows).toBeLessThanOrEqual(GRID_LIMITS.maxRows);
      expect(grid.cols * grid.rows).toBeLessThanOrEqual(GRID_LIMITS.maxCells);
      const outAspect = (grid.rows * g.cellH) / (grid.cols * g.cellW);
      expect(Math.abs(h / w / outAspect - 1)).toBeLessThanOrEqual(0.5 / grid.rows + 1e-12);
    }
  });

  it('never returns zero rows for extreme panoramas', () => {
    expect(gridSize(20_000, 10, 20, g).rows).toBe(1);
  });
});
