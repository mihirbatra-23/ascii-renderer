import { quantize } from 'gifenc';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/engine/types';
import {
  DelayAccumulator,
  fixedPalette,
  MIN_GIF_DELAY_CS,
  PaletteMapper,
  samplePixels,
  snapToPalette,
  usesFixedPalette,
  withTransparentSlot,
} from '../../src/export/gif-palette';

describe('DelayAccumulator', () => {
  it('carries rounding error forward so the total stays exact', () => {
    const acc = new DelayAccumulator();
    const delays = Array.from({ length: 30 }, () => acc.next(1000 / 30));
    expect(delays.reduce((a, b) => a + b, 0)).toBe(100); // 1 s exactly
    expect(new Set(delays)).toEqual(new Set([3, 4]));
  });

  it('keeps exact delays exact', () => {
    const acc = new DelayAccumulator();
    expect([120, 40, 120, 40].map((d) => acc.next(d))).toEqual([12, 4, 12, 4]);
  });

  it('never emits a delay browsers would stretch to 100 ms', () => {
    const acc = new DelayAccumulator();
    const delays = [5, 5, 5, 100].map((d) => acc.next(d));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(MIN_GIF_DELAY_CS);
    // the clamped-up time is paid back by later frames
    expect(delays.reduce((a, b) => a + b, 0)).toBe(12);
  });
});

describe('fixed palettes', () => {
  it('mono: paper + ink blends, ≤ 32 entries, exact endpoints', () => {
    const pal = fixedPalette({ ...DEFAULT_PARAMS, colorMode: 'mono', ink: '#ffffff', paper: '#000000' });
    expect(pal.length).toBeLessThanOrEqual(32);
    expect(pal).toContainEqual([0, 0, 0]);
    expect(pal).toContainEqual([255, 255, 255]);
  });

  it('duotone: glyph tints × coverage levels, ≤ 32 entries', () => {
    const pal = fixedPalette({ ...DEFAULT_PARAMS, colorMode: 'duotone' });
    expect(pal.length).toBeGreaterThan(16);
    expect(pal.length).toBeLessThanOrEqual(32);
    expect(pal).toContainEqual([0x0b, 0x0b, 0x0c]); // paper
    expect(pal).toContainEqual([0xe8, 0xe6, 0xdf]); // full ink
    expect(pal).toContainEqual([0x3b, 0x5b, 0xdb]); // full shadow ink
  });

  it('maps ink and paper exactly, and anti-aliased pixels to the nearest blend', () => {
    const pal = fixedPalette({ ...DEFAULT_PARAMS, colorMode: 'mono' });
    const mapper = new PaletteMapper(pal, [0x0b, 0x0b, 0x0c]);
    const idx = [...mapper.map(new Uint8Array([0x0b, 0x0b, 0x0c, 255, 0xe8, 0xe6, 0xdf, 255, 0x7a, 0x79, 0x76, 255]))];
    expect(pal[idx[0]]).toEqual([0x0b, 0x0b, 0x0c]);
    expect(pal[idx[1]]).toEqual([0xe8, 0xe6, 0xdf]);
    const mid = pal[idx[2]];
    expect(Math.abs(mid[0] - 0x7a)).toBeLessThan(12);
  });

  it('source colour uses an adaptive palette', () => {
    expect(usesFixedPalette({ colorMode: 'source' })).toBe(false);
    expect(usesFixedPalette({ colorMode: 'mono' })).toBe(true);
    expect(usesFixedPalette({ colorMode: 'duotone' })).toBe(true);
  });
});

describe('PaletteMapper (stable across frames)', () => {
  it('gives a colour the same index whatever else is in the frame or came first', () => {
    const pal = quantize(Uint8Array.from({ length: 4096 * 4 }, (_, i) => (i * 37) % 256), 64);
    const pixel = [123, 45, 200, 255];
    const alone = new PaletteMapper(pal).map(Uint8Array.from(pixel))[0];
    const crowd = Uint8Array.from({ length: 1000 * 4 }, (_, i) => (i * 13 + 7) % 256);
    crowd.set(pixel, 999 * 4);
    const mapper = new PaletteMapper(pal);
    expect(mapper.map(crowd)[999]).toBe(alone);
    // The same mapper keeps it for later frames too.
    expect(mapper.map(Uint8Array.from(pixel))[0]).toBe(alone);
  });

  it('the preferred colour (paper) wins its bin over a near-identical palette entry', () => {
    const pal = [
      [12, 12, 13],
      [11, 11, 12],
      [250, 250, 250],
    ];
    expect(new PaletteMapper(pal, [11, 11, 12]).map(Uint8Array.of(11, 11, 12, 255))[0]).toBe(1);
  });

  it('reserves one table slot that no colour maps to, for the transparent index', () => {
    const pal = fixedPalette({ ...DEFAULT_PARAMS, colorMode: 'duotone' });
    const { table, transparentIndex } = withTransparentSlot(pal, [11, 11, 12]);
    expect(transparentIndex).toBe(pal.length);
    expect(table).toHaveLength(pal.length + 1);
    const mapped = new PaletteMapper(pal).map(Uint8Array.from({ length: 2048 }, (_, i) => (i * 97) % 256));
    expect(Math.max(...mapped)).toBeLessThan(transparentIndex);
    expect(() => withTransparentSlot(new Array(256).fill([0, 0, 0]), [0, 0, 0])).toThrow(RangeError);
  });
});

describe('adaptive palette helpers', () => {
  it('samples a bounded number of pixels', () => {
    const rgba = new Uint8Array(1000 * 4).map((_, i) => i % 251);
    const s = samplePixels(rgba, 100);
    expect(s.length / 4).toBeLessThanOrEqual(100);
    expect([...s.slice(0, 3)]).toEqual([...rgba.slice(0, 3)]);
  });

  it('snaps the nearest quantized entry to the exact paper colour', () => {
    const px = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i++) px.set(i < 48 ? [12, 11, 13, 255] : [200, 30, 40, 255], i * 4);
    const pal = snapToPalette(quantize(px, 256), [11, 11, 12]);
    expect(pal).toContainEqual([11, 11, 12]);
    expect(pal.every((c) => c.length === 3)).toBe(true);
  });
});
