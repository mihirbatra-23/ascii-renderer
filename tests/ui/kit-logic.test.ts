import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, normalizeHex } from '../../src/ui/kit/color';
import { readIntent, TOUCH_SLOP_PX, waitsForIntent } from '../../src/ui/kit/gesture';
import { formatRange } from '../../src/ui/kit/Tooltip';
import { capReason } from '../../src/ui/inspector/gridCap';

describe('pointer intent', () => {
  it('lets a mouse act at once and makes touch and pen wait', () => {
    expect(waitsForIntent('mouse')).toBe(false);
    expect(waitsForIntent('touch')).toBe(true);
    expect(waitsForIntent('pen')).toBe(true);
  });

  it('reads a mostly vertical movement as a scroll and a mostly sideways one as an adjustment', () => {
    expect(readIntent(3, 4, TOUCH_SLOP_PX)).toBe('pending');
    expect(readIntent(3, -40, TOUCH_SLOP_PX)).toBe('scroll');
    expect(readIntent(25, -150, TOUCH_SLOP_PX)).toBe('scroll');
    expect(readIntent(12, 5, TOUCH_SLOP_PX)).toBe('adjust');
    expect(readIntent(-12, 11, TOUCH_SLOP_PX)).toBe('adjust');
  });
});

describe('column cap reason', () => {
  const cell = { cellW: 8, cellH: 16 };
  it('names the row limit for tall sources', () => {
    // tall_300x3000 at 160 columns is capped to 80 × 400 = 32,000 cells: rows bind, not cells.
    expect(capReason({ cols: 80, rows: 400 }, 300, 3000, cell)).toBe('rows');
  });
  it('names the cell limit when rows still have room', () => {
    // A 5:9 portrait (0.9 rows per column): 400 columns would be 400 × 360 = 144,000 cells, so the
    // grid stops at 365 × 329 (≤ 120,000 cells) with rows well under 400.
    expect(capReason({ cols: 365, rows: 329 }, 1000, 1800, cell)).toBe('cells');
  });
});

describe('colour popover conversions', () => {
  it('reads #rgb and #rrggbb in any case, and rejects anything else', () => {
    expect(normalizeHex('E6E4DF')).toBe('#e6e4df');
    expect(normalizeHex('#fA0')).toBe('#ffaa00');
    expect(normalizeHex('#ggg')).toBeNull();
    expect(normalizeHex('12345')).toBeNull();
  });

  it('round-trips every theme colour through HSV', () => {
    for (const hex of ['#e6e4df', '#5c5953', '#0b0b0c', '#e4e7e8', '#0a0b0b', '#3b5bdb', '#000000', '#ffffff']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('maps the primaries to their hues', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#00ff00').h).toBe(120);
    expect(hexToHsv('#0000ff').h).toBe(240);
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe('#ffff00');
  });
});

describe('tooltip range line', () => {
  it('takes its decimals from the step, at least two when fractional', () => {
    expect(formatRange(0.4, 2.5, 0.01)).toEqual(['0.40', '2.50']);
    expect(formatRange(1, 1.6, 0.05)).toEqual(['1.00', '1.60']);
    expect(formatRange(0, 1, 0.1)).toEqual(['0.00', '1.00']);
    expect(formatRange(40, 400, 1)).toEqual(['40', '400']);
  });

  it('signs a bipolar range with the minus sign and a plus', () => {
    expect(formatRange(-0.5, 0.5, 0.01, { bipolar: true })).toEqual(['−0.50', '+0.50']);
  });

  it('appends a unit to both ends', () => {
    expect(formatRange(0, 90, 1, { unit: '°' })).toEqual(['0°', '90°']);
  });
});
