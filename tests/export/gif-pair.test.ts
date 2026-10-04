import { describe, expect, it } from 'vitest';
import { gifPairBytes } from '../../src/export/gif-pair';
import type { Palette } from '../../src/export/gif-palette';
import type { OwnedPixels } from '../../src/export/resample';

const INK: [number, number, number] = [240, 240, 240];
const PAPER: [number, number, number] = [10, 10, 10];
const MONO: Palette = [PAPER, INK];

/** A frame of `width` × `height` with ink wherever `ink(x, y)` holds, paper elsewhere. */
function frame(width: number, height: number, ink: (x: number, y: number) => boolean): OwnedPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([...(ink(x, y) ? INK : PAPER), 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** A grid of 8 × 16 "glyph" cells whose ink pattern depends on `seed` per cell. */
function cells(seed: (col: number, row: number) => number): OwnedPixels {
  return frame(320, 160, (x, y) => {
    const s = seed(Math.floor(x / 8), Math.floor(y / 16));
    return ((x % 8) * 3 + (y % 16) * s) % 7 < s % 5;
  });
}

// GIF sizes are estimated from real delta frames, encoded as the exporter encodes.
describe('gifPairBytes', () => {
  it('a frame that does not change costs a few bytes, not another frame', () => {
    const a = cells((c, r) => c * 7 + r * 3);
    const { firstBytes, deltaBytes } = gifPairBytes(a, a, MONO, PAPER);
    expect(firstBytes).toBeGreaterThan(1000);
    expect(deltaBytes).toBeLessThan(40);
  });

  it('the delta grows with the share of cells that change', () => {
    const a = cells((c, r) => c * 7 + r * 3);
    const some = cells((c, r) => (c < 8 ? c * 5 + r : c * 7 + r * 3));
    const all = cells((c, r) => c * 5 + r * 11 + 1);
    const small = gifPairBytes(a, some, MONO, PAPER);
    const large = gifPairBytes(a, all, MONO, PAPER);
    expect(small.deltaBytes).toBeGreaterThan(40);
    expect(small.deltaBytes).toBeLessThan(large.deltaBytes / 2);
    // A frame where every cell changed costs about a whole frame (the life_5s case, which was read 1.7× low).
    expect(large.deltaBytes / large.firstBytes).toBeGreaterThan(0.6);
  });

  it('builds an adaptive palette when none is fixed', () => {
    const a = cells((c, r) => c + r);
    const b = cells((c, r) => c + r + 1);
    const { firstBytes, deltaBytes } = gifPairBytes(a, b, null, PAPER);
    expect(firstBytes).toBeGreaterThan(0);
    expect(deltaBytes).toBeGreaterThan(0);
  });
});
