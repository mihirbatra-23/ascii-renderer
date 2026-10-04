import { describe, expect, it } from 'vitest';
import {
  BRAILLE_BITS,
  brailleChar,
  CHARSET_PRESETS,
  HALFTONE_TEXT_RAMP,
  halftoneTextIndex,
  MAX_GLYPHS,
  QUADRANT_CHARS,
  rampCharset,
  rampOrder,
  resolveCharset,
} from '../../src/engine/charsets';

describe('resolveCharset', () => {
  it('ascii is the 95 printable characters with the space first', () => {
    const chars = resolveCharset({ charsetPreset: 'ascii', customCharset: '' });
    expect(chars.length).toBe(95);
    expect(chars[0]).toBe(' ');
    expect(chars.join('')).toBe(CHARSET_PRESETS.ascii);
  });

  it('dedupes, drops undrawable code points, keeps astral characters whole and puts space first', () => {
    const chars = resolveCharset({ charsetPreset: 'custom', customCharset: 'ab\tba\n​😀 c😀\u0007' });
    expect(chars).toEqual([' ', 'a', 'b', '😀', 'c']);
  });

  it('an empty custom set falls back to ASCII; long sets are capped', () => {
    expect(resolveCharset({ charsetPreset: 'custom', customCharset: '  \n' }).length).toBe(95);
    const many = Array.from({ length: 600 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    expect(resolveCharset({ charsetPreset: 'custom', customCharset: many }).length).toBe(MAX_GLYPHS);
  });

  it('every preset resolves to unique characters', () => {
    for (const preset of ['ascii', 'minimal', 'dense', 'lines'] as const) {
      const chars = resolveCharset({ charsetPreset: preset, customCharset: '' });
      expect(new Set(chars).size).toBe(chars.length);
      expect(chars[0]).toBe(' ');
    }
  });
});

describe('braille table (§6)', () => {
  it('maps (dx, dy) to the Unicode dot numbering', () => {
    // Unicode dots 1-2-3 / 4-5-6 run down the left / right columns, dots 7 and 8 are the bottom row.
    const expected: Record<string, number> = {
      '0,0': 0x01,
      '0,1': 0x02,
      '0,2': 0x04,
      '1,0': 0x08,
      '1,1': 0x10,
      '1,2': 0x20,
      '0,3': 0x40,
      '1,3': 0x80,
    };
    for (const [k, bit] of Object.entries(expected)) {
      const [dx, dy] = k.split(',').map(Number);
      expect(BRAILLE_BITS[dy][dx]).toBe(bit);
    }
    expect(brailleChar(0)).toBe('⠀');
    expect(brailleChar(0xff)).toBe('⣿');
    expect(brailleChar(0x01 | 0x08)).toBe('⠉');
  });
});

describe('quadrant table (§6)', () => {
  it('indexes the 16 block elements by TL=1, TR=2, BL=4, BR=8', () => {
    const codepoints = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588];
    expect(Array.from(QUADRANT_CHARS, (c) => c.codePointAt(0))).toEqual(codepoints);
  });
});

describe('halftone text ramp', () => {
  it('maps coverage monotonically onto " ·•●"', () => {
    expect(HALFTONE_TEXT_RAMP).toBe(' ·•●');
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.01) {
      const i = halftoneTextIndex(c);
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
    expect(halftoneTextIndex(0)).toBe(0);
    expect(halftoneTextIndex(1)).toBe(3);
  });
});

describe('rampOrder', () => {
  it('sorts by coverage, ties by index', () => {
    expect(Array.from(rampOrder([0.5, 0, 0.25, 0.25, 1]))).toEqual([1, 2, 3, 0, 4]);
  });
});

// Ramp over Full ASCII matched tone against 95 glyphs and read as letter noise.
describe('rampCharset', () => {
  it('gives the shape-matching presets the classic tonal ramp and leaves the others alone', () => {
    expect(rampCharset({ charsetPreset: 'ascii' })?.join('')).toBe(CHARSET_PRESETS.minimal);
    expect(rampCharset({ charsetPreset: 'dense' })?.join('')).toBe(CHARSET_PRESETS.minimal);
    expect(rampCharset({ charsetPreset: 'minimal' })).toBeUndefined();
    expect(rampCharset({ charsetPreset: 'lines' })).toBeUndefined();
    expect(rampCharset({ charsetPreset: 'custom' })).toBeUndefined();
  });
});
