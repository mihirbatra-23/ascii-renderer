import { describe, expect, it } from 'vitest';
import { buildRectTaps, buildTapTables, EXTERNAL_CIRCLES, INTERNAL_CIRCLES, packTapTables, type TapTable } from '../../src/engine/layout';

const sum = (t: TapTable) => t.w.reduce((a, b) => a + b, 0);

/** Partner of each circle under (x, y) → (1 − x, 1 − y). */
function partnerOf(list: readonly { x: number; y: number }[], i: number): number {
  const c = list[i];
  return list.findIndex((o) => Math.abs(o.x - (1 - c.x)) < 1e-9 && Math.abs(o.y - (1 - c.y)) < 1e-9);
}

function mirrored(t: TapTable, sw: number, sh: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < t.w.length; i++) m.set(`${sw - 1 - t.dx[i]},${sh - 1 - t.dy[i]}`, t.w[i]);
  return m;
}

describe.each([13, 16, 20])('tap tables (SW 8, SH %i)', (sh) => {
  const sw = 8;
  const tables = buildTapTables(sw, sh);

  it('weights of every circle sum to 1 and are positive', () => {
    for (const t of [...tables.internal, ...tables.external]) {
      expect(sum(t)).toBeCloseTo(1, 12);
      for (const w of t.w) expect(w).toBeGreaterThan(0);
    }
  });

  it('internal taps stay inside the cell; every external circle reaches outside it', () => {
    for (const t of tables.internal) {
      for (let i = 0; i < t.w.length; i++) {
        expect(t.dx[i]).toBeGreaterThanOrEqual(0);
        expect(t.dx[i]).toBeLessThan(sw);
        expect(t.dy[i]).toBeGreaterThanOrEqual(0);
        expect(t.dy[i]).toBeLessThan(sh);
      }
    }
    for (const t of tables.external) {
      const outside = Array.from(t.dx, (dx, i) => dx < 0 || dx >= sw || t.dy[i] < 0 || t.dy[i] >= sh);
      expect(outside.some(Boolean)).toBe(true);
    }
  });

  it('the layout and its tap tables are exactly 180° symmetric', () => {
    for (const [list, set] of [
      [INTERNAL_CIRCLES, tables.internal],
      [EXTERNAL_CIRCLES, tables.external],
    ] as const) {
      list.forEach((_, i) => {
        const j = partnerOf(list, i);
        expect(j).toBeGreaterThanOrEqual(0);
        const a = mirrored(set[i], sw, sh);
        const b = set[j];
        expect(a.size).toBe(b.w.length);
        for (let k = 0; k < b.w.length; k++) expect(a.get(`${b.dx[k]},${b.dy[k]}`)).toBe(b.w[k]);
      });
    }
  });

  it('sub-cell rectangles are equal-area, normalised and tile the cell', () => {
    for (const [nx, ny] of [
      [2, 4],
      [2, 2],
    ]) {
      const rects = buildRectTaps(sw, sh, nx, ny);
      const cover = new Float64Array(sw * sh);
      for (const t of rects) {
        expect(sum(t)).toBeCloseTo(1, 12);
        for (let i = 0; i < t.w.length; i++) cover[t.dy[i] * sw + t.dx[i]] += (t.w[i] * sw * sh) / (nx * ny);
      }
      for (const c of cover) expect(c).toBeCloseTo(1, 9);
    }
  });
});

describe('packTapTables', () => {
  it('flattens tables in order with matching offsets and counts', () => {
    const tables = buildTapTables(8, 16);
    const all = [...tables.internal, ...tables.external];
    const packed = packTapTables(all);
    expect(packed.offsets.length).toBe(16);
    all.forEach((t, i) => {
      expect(packed.counts[i]).toBe(t.w.length);
      const o = packed.offsets[i] * 3;
      expect(packed.taps[o]).toBe(t.dx[0]);
      expect(packed.taps[o + 1]).toBe(t.dy[0]);
      expect(packed.taps[o + 2]).toBeCloseTo(t.w[0], 6);
    });
    expect(packed.taps.length).toBe(3 * all.reduce((n, t) => n + t.w.length, 0));
  });
});
