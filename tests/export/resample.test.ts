import { describe, expect, it } from 'vitest';
import { areaTaps, resampleArea } from '../../src/export/resample';

function raster(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

describe('areaTaps', () => {
  it('covers each output with source coverage weights that sum to 1', () => {
    for (const [src, dst] of [
      [10, 10],
      [10, 7],
      [2560, 1920],
      [1301, 17],
      [9, 1],
    ]) {
      const taps = areaTaps(src, dst);
      let covered = 0;
      for (let o = 0; o < dst; o++) {
        let sum = 0;
        for (let k = 0; k < taps.count[o]; k++) sum += taps.weights[o * taps.stride + k];
        expect(sum).toBeCloseTo(1, 5);
        covered += sum * (src / dst);
      }
      expect(covered).toBeCloseTo(src, 3);
    }
  });
});

describe('resampleArea (exact-width exports)', () => {
  it('returns exactly the requested size and keeps flat colours exact', () => {
    const out = resampleArea(raster(64, 36, () => [11, 11, 12, 255]), { width: 50, height: 28 });
    expect(out.width).toBe(50);
    expect(out.height).toBe(28);
    expect(new Set(out.data)).toEqual(new Set([11, 12, 255]));
  });

  it('averages in linear light: a 1 px black/white pattern halves to sRGB 188, not 128', () => {
    const out = resampleArea(raster(4, 2, (x) => (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])), { width: 2, height: 1 });
    expect([...out.data.subarray(0, 4)]).toEqual([188, 188, 188, 255]);
  });

  it('weights colours by alpha, so transparent pixels do not bleed their colour into edges', () => {
    const out = resampleArea(raster(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0])), { width: 1, height: 1 });
    expect([...out.data]).toEqual([255, 0, 0, 128]);
  });

  it('copies when the size is unchanged and refuses to enlarge', () => {
    const src = raster(3, 2, (x, y) => [x * 50, y * 90, 7, 255]);
    expect(resampleArea(src, { width: 3, height: 2 }).data).toEqual(src.data);
    expect(() => resampleArea(src, { width: 4, height: 2 })).toThrow(RangeError);
  });

  it('keeps a feature where it was (no shift when shrinking 2560 → 1920)', () => {
    const src = raster(2560, 4, (x) => (x >= 1280 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = resampleArea(src, { width: 1920, height: 3 });
    expect(out.data[(959 * 4) | 0]).toBe(0);
    expect(out.data[960 * 4]).toBe(255);
  });
});
