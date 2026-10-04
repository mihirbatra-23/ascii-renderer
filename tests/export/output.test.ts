import { describe, expect, it } from 'vitest';
import type { AsciiEngine, CellGeometry, GridSize } from '../../src/engine/types';
import { ExportError } from '../../src/export/errors';
import { needsResample, planOutput, targetSize } from '../../src/export/output';
import { PaddedFrame, transferableBytes } from '../../src/export/pixels';
import { GEOMETRY } from './helpers';

/** Only what planOutput reads from an engine. */
function engine(grid: GridSize, geometry: CellGeometry = GEOMETRY, maxRasterSize = 16384): AsciiEngine {
  return { getGrid: () => grid, getGeometry: () => geometry, maxRasterSize } as AsciiEngine;
}

describe('targetSize (ExportOptions.targetWidth)', () => {
  it('renders at the next integer scale and keeps the aspect to within half a pixel', () => {
    expect(targetSize({ width: 1280, height: 720 }, 1920)).toEqual({ scale: 2, size: { width: 1920, height: 1080 } });
    expect(targetSize({ width: 1280, height: 720 }, 2560)).toEqual({ scale: 2, size: { width: 2560, height: 1440 } });
    expect(targetSize({ width: 1280, height: 720 }, 640)).toEqual({ scale: 1, size: { width: 640, height: 360 } });
    const odd = targetSize({ width: 1288, height: 714 }, 1000);
    expect(odd.scale).toBe(1);
    expect(Math.abs(odd.size.height - (1000 * 714) / 1288)).toBeLessThanOrEqual(0.5);
  });
});

describe('planOutput', () => {
  it('plans the exact geometry size at an integer scale and captures the grid it renders', () => {
    const plan = planOutput(engine({ cols: 160, rows: 45 }), { scale: 2, margin: 3 });
    expect(plan.rasterSize).toEqual({ width: (160 * 8 + 6) * 2, height: (45 * 16 + 6) * 2 });
    expect(plan.size).toEqual(plan.rasterSize);
    expect(plan.raster).toEqual({ scale: 2, margin: 3, transparentBackground: false });
    expect(plan.grid).toEqual({ cols: 160, rows: 45 });
    expect(needsResample(plan)).toBe(false);
  });

  it('a target width overrides the scale and asks for a resample', () => {
    const plan = planOutput(engine({ cols: 160, rows: 45 }), { scale: 4, targetWidth: 1920 });
    expect(plan.raster.scale).toBe(2);
    expect(plan.size).toEqual({ width: 1920, height: 1080 });
    expect(needsResample(plan)).toBe(true);
  });

  it('fails with advice when the render would exceed the device', () => {
    expect(() => planOutput(engine({ cols: 400, rows: 225 }, GEOMETRY, 8192), { scale: 3 })).toThrow(/Use 2× or lower/);
    const wide = () => planOutput(engine({ cols: 400, rows: 225 }, GEOMETRY, 8192), { scale: 1, targetWidth: 9000 });
    expect(wide).toThrow(ExportError);
    expect(wide).toThrow(/widest export here is 6400 px/);
  });
});

describe('PaddedFrame', () => {
  it('pads to the frame size with the fill colour and copies rows without scaling', () => {
    const frame = new PaddedFrame({ width: 4, height: 3 }, [1, 2, 3, 255]);
    const raster = { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4).fill(200) };
    const data = frame.place(raster);
    const px = (x: number, y: number) => [...data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([200, 200, 200, 200]);
    expect(px(2, 1)).toEqual([200, 200, 200, 200]);
    expect(px(3, 0)).toEqual([1, 2, 3, 255]);
    expect(px(0, 2)).toEqual([1, 2, 3, 255]);
    // The padding survives later frames.
    frame.place({ ...raster, data: raster.data.fill(9) });
    expect(px(3, 2)).toEqual([1, 2, 3, 255]);
  });

  it('transfers the raster buffer itself when it spans exactly the pixels, a copy otherwise', () => {
    const data = new Uint8ClampedArray(16);
    expect(transferableBytes({ width: 2, height: 2, data })).toBe(data.buffer);
    const view = new Uint8ClampedArray(new ArrayBuffer(32), 8, 16);
    const bytes = transferableBytes({ width: 2, height: 2, data: view });
    expect(bytes).not.toBe(view.buffer);
    expect(bytes.byteLength).toBe(16);
  });
});
