import { describe, expect, it } from 'vitest';
import { buildGlyphSet, drawGlyph, type GlyphSet } from '../../src/engine/atlas';
import { resolveCharset } from '../../src/engine/charsets';
import { factory, FONT_IDS, params, pipeline } from './helpers';

const vec = (g: GlyphSet, ch: string) => {
  const i = g.chars.indexOf(ch);
  expect(i, `glyph ${JSON.stringify(ch)} kept`).toBeGreaterThanOrEqual(0);
  return Array.from(g.vectors.subarray(i * 6, i * 6 + 6));
};
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, k) => v - b[k]));
// Circle rows: 0-1 top, 2-3 middle, 4-5 bottom.
const rowInk = (v: number[]) => [v[0] + v[1], v[2] + v[3], v[4] + v[5]];

describe.each(FONT_IDS)('glyph set for %s / printable ASCII (§4)', (font) => {
  const { glyphSet: g } = pipeline(params({ font }));

  it('keeps all 95 printable characters, space first with a zero vector', () => {
    expect(g.dropped).toEqual([]);
    expect(g.chars.length).toBe(95);
    expect(g.chars[0]).toBe(' ');
    expect(vec(g, ' ')).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('normalises per component: every component peaks at exactly 1', () => {
    for (let k = 0; k < 6; k++) {
      let m = 0;
      for (let i = 0; i < g.chars.length; i++) m = Math.max(m, g.vectors[i * 6 + k]);
      expect(m).toBeCloseTo(1, 6);
    }
  });

  it('anchor W is the largest mean component', () => {
    expect(g.anchor).toBeCloseTo(Math.max(...g.meanCoverage), 6);
    expect(g.anchor).toBeGreaterThan(0.5);
    expect(g.anchor).toBeLessThanOrEqual(1);
  });

  it("'-', '_' and '.' have distinct vectors at their real positions (the original's bug)", () => {
    const minus = vec(g, '-');
    const under = vec(g, '_');
    const dot = vec(g, '.');
    const [mt, mm, mb] = rowInk(minus);
    expect(mm).toBeGreaterThan(0.3);
    expect(mt + mb).toBeLessThan(0.1 * mm);
    const [ut, um, ub] = rowInk(under);
    expect(ub).toBeGreaterThan(0.3);
    expect(ut + um).toBeLessThan(0.1 * ub);
    const [dt, , db] = rowInk(dot);
    expect(db).toBeGreaterThan(0.3);
    expect(dt).toBe(0);
    expect(dist(minus, under)).toBeGreaterThan(0.3);
    expect(dist(minus, dot)).toBeGreaterThan(0.3);
    expect(dist(under, dot)).toBeGreaterThan(0.1);
  });

  it("'`' and ''' sit at the top, '|' spans the cell", () => {
    expect(rowInk(vec(g, '`'))[2]).toBe(0);
    expect(rowInk(vec(g, '`'))[0]).toBeGreaterThan(0.3);
    expect(Math.min(...rowInk(vec(g, '|')))).toBeGreaterThan(0.5);
  });

  it('no two kept glyphs are within the dedupe distance', () => {
    for (let i = 0; i < g.chars.length; i++) {
      for (let j = i + 1; j < g.chars.length; j++) expect(dist(vec(g, g.chars[i]), vec(g, g.chars[j]))).toBeGreaterThan(1e-3);
    }
  });
});

describe('glyph availability', () => {
  it('drops characters the font does not have and characters without ink', () => {
    const { geometry, taps } = pipeline(params());
    const chars = resolveCharset({ charsetPreset: 'custom', customCharset: 'A中😀█⠿░·' });
    const g = buildGlyphSet(chars, geometry, factory, taps);
    expect(g.chars).toEqual([' ', 'A', '·']);
    expect(g.dropped.sort()).toEqual(['中', '😀', '█', '⠿', '░'].sort());
  });

  it('every preset keeps all of its characters in every bundled font', () => {
    for (const font of FONT_IDS) {
      for (const charsetPreset of ['ascii', 'minimal', 'dense', 'lines'] as const) {
        const { glyphSet } = pipeline(params({ font, charsetPreset }));
        expect(glyphSet.dropped, `${font} ${charsetPreset}`).toEqual([]);
        expect(glyphSet.chars.length).toBe(resolveCharset({ charsetPreset, customCharset: '' }).length);
      }
    }
  });

  it('dedupes glyphs whose normalised vectors coincide', () => {
    const { geometry, taps } = pipeline(params());
    // resolveCharset never repeats a character, but buildGlyphSet takes any list: a repeat is an exact duplicate.
    const g = buildGlyphSet([' ', 'x', 'x'], geometry, factory, taps);
    expect(g.chars).toEqual([' ', 'x']);
    expect(g.dropped).toEqual(['x']);
  });
});

describe('drawGlyph', () => {
  it('puts the alphabetic baseline at baselineY and the pen at penX', () => {
    const { geometry } = pipeline(params());
    const s = 4;
    const { ctx } = factory(64, 96);
    ctx.fillStyle = '#fff';
    drawGlyph(ctx, 'H', 16, 60, geometry.fontSize * s, geometry.fontFamily);
    const data = ctx.getImageData(0, 0, 64, 96).data;
    let minX = 64;
    let maxY = 0;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 64; x++) {
        if (data[(y * 64 + x) * 4 + 3] > 128) {
          minX = Math.min(minX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    // 'H' rests on the baseline (its last solid row is just above y = 60) and has a small left bearing.
    expect(maxY).toBe(59);
    expect(minX).toBeGreaterThanOrEqual(16);
    expect(minX).toBeLessThan(16 + geometry.cellW * s * 0.25);
  });
});
