import { describe, expect, it } from 'vitest';
import type { CellGeometry } from '../../src/engine/types';
import { canBeTransparent, customSize, formatByteRange, nearestScale, planExport, type EngineGeometry, type PlanInput } from '../../src/ui/export/sizing';

const geometry: CellGeometry = { cellW: 8, cellH: 16, fontSize: 13.33, baseline: 12, fontFamily: 'Geist Mono', advanceEm: 0.6 };
/** torus at 160 columns: 160 × 45 cells of 8 × 16 px = 1280 × 720 at 1×, a 1280 × 720 source. */
const torus: EngineGeometry = { cols: 160, rows: 45, geometry, maxRasterSize: 16384 };
const source = { width: 1280, height: 720 };
const input = (patch: Partial<PlanInput> = {}): PlanInput => ({ format: 'png', scale: 2, motionScale: 1, margin: 0, ...patch });

describe('planExport', () => {
  it('writes PNG at the still scale and motion formats at their own', () => {
    expect(planExport(input(), torus, source)).toMatchObject({ width: 2560, height: 1440, scale: 2, renderScale: 2 });
    expect(planExport(input({ format: 'gif' }), torus, source)).toMatchObject({ width: 1280, height: 720, scale: 1 });
    expect(planExport(input({ format: 'mp4', motionScale: 2 }), torus, source)).toMatchObject({ width: 2560, height: 1440 });
  });

  it('never writes a scale the picker does not offer when the picked one does not fit', () => {
    // 355 × 336 cells → 2840 × 5376 at 1×: 3× fits a 16384 px device, 4× does not.
    const tall: EngineGeometry = { cols: 355, rows: 336, geometry, maxRasterSize: 16384 };
    const plan = planExport(input({ scale: 4 }), tall, { width: 633, height: 1200 });
    expect(plan.maxScale).toBe(3);
    expect(plan.renderScale).toBe(2);
    expect(plan.width).toBe(2840 * 2);
    expect(plan.scaleTooLarge).toEqual({ scale: 4, width: 2840 * 4, height: 5376 * 4 });
  });

  it('makes a custom width exactly that wide, height from the grid aspect', () => {
    const plan = planExport(input({ scale: 'custom', customWidth: 1920 }), torus, source);
    expect(plan).toMatchObject({ width: 1920, height: 1080, targetWidth: 1920, renderScale: 2, scale: 1.5 });
    expect(plan.cell).toEqual({ width: 12, height: 24 });
    expect(plan.check.kind).toBe('aspect');
  });

  it('treats a custom width that is a whole multiple as that scale (no resample)', () => {
    const plan = planExport(input({ scale: 'custom', customWidth: 2560 }), torus, source);
    expect(plan.targetWidth).toBeUndefined();
    expect(plan).toMatchObject({ width: 2560, height: 1440, renderScale: 2 });
    expect(plan.check.kind).toBe('exact');
  });

  it('pads a custom size to even numbers for video, never scaling', () => {
    const plan = planExport(input({ format: 'mp4', motionScale: 'custom', customWidth: 1001 }), torus, source);
    expect(plan.raster).toEqual({ width: 1001, height: 563 });
    expect(plan).toMatchObject({ width: 1002, height: 564, padded: true });
  });

  it('tells TXT users the line height that keeps the aspect', () => {
    const geo: EngineGeometry = { ...torus, geometry: { ...geometry, cellH: 16, fontSize: 13.333 } };
    expect(planExport(input({ format: 'txt' }), geo, source).check.text).toContain('Set line height to 1.2 in your editor');
  });

  it('checks the aspect from integers', () => {
    expect(planExport(input(), torus, source).check.kind).toBe('exact');
    const warn = planExport(input(), { ...torus, rows: 42 }, { width: 480, height: 253 }).check;
    expect(warn.kind).toBe('warn');
  });
});

describe('customSize', () => {
  const base = { width: 1280, height: 720 };
  const grid = { cols: 160, rows: 45 };
  it('clamps to one pixel per column and to what the device can render', () => {
    expect(customSize(10, base, grid, 4)).toMatchObject({ width: 160, height: 90, renderScale: 1 });
    expect(customSize(99999, base, grid, 3)).toMatchObject({ width: 3840, height: 2160, renderScale: 3 });
  });
});

describe('nearestScale', () => {
  it('picks the closest offered scale the device can draw', () => {
    expect(nearestScale({ scale: 1.4, maxScale: 4 })).toBe(1);
    expect(nearestScale({ scale: 1.5, maxScale: 4 })).toBe(2);
    expect(nearestScale({ scale: 3.5, maxScale: 4 })).toBe(4);
    expect(nearestScale({ scale: 3.5, maxScale: 3 })).toBe(2);
  });
});

describe('canBeTransparent', () => {
  const look = { mode: 'shape', colorMode: 'mono' } as const;
  it('needs an alpha format', () => {
    expect(canBeTransparent('png', look)).toBe(true);
    expect(canBeTransparent('webm', look)).toBe(true);
    expect(canBeTransparent('gif', look)).toBe(false);
    expect(canBeTransparent('mp4', look)).toBe(false);
  });
  it('is off for Blocks in Source colour, which paints every cell', () => {
    expect(canBeTransparent('png', { mode: 'blocks', colorMode: 'source' })).toBe(false);
    expect(canBeTransparent('png', { mode: 'blocks', colorMode: 'mono' })).toBe(true);
  });
});

describe('formatByteRange', () => {
  it('writes both ends in the unit of the larger', () => {
    expect(formatByteRange(1_900_000, 3_100_000)).toBe('1.9–3.1 MB');
    expect(formatByteRange(785_000, 1_300_000)).toBe('0.8–1.3 MB');
    expect(formatByteRange(7_200_000, 14_000_000)).toBe('7–14 MB');
    expect(formatByteRange(300_000, 520_000)).toBe('300–520 KB');
  });
});
