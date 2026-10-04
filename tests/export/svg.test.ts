import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { CHARSET_PRESETS } from '../../src/engine/charsets';
import type { FontId } from '../../src/engine/types';
import type { GlyphOutlines } from '../../src/export/outlines';
import { snapshotToSvg } from '../../src/export/svg';
import { compileGlyph } from '../../src/export/svg-glyphs';
import { formatHundredths, num } from '../../src/export/svg-number';
import { absolutePathPoints, assertWellFormedXml, GEOMETRY, makeSnapshot } from './helpers';

const root = join(__dirname, '../..');
const FONTS: FontId[] = ['jetbrains-mono', 'ibm-plex-mono', 'geist-mono'];
const outlinesFor = (id: FontId) =>
  JSON.parse(readFileSync(join(root, 'src/export/outlines', `${id}.json`), 'utf8')) as GlyphOutlines;
const parseFont = (id: FontId) => {
  const b = readFileSync(join(root, `node_modules/@fontsource/${id}/files/${id}-latin-400-normal.woff`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const attr = (svg: string, el: string, name: string) =>
  [...svg.matchAll(new RegExp(`<${el}\\b[^>]*\\b${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

describe('svg numbers', () => {
  it('formats with at most two decimals and no redundant zeros', () => {
    expect(num(0)).toBe('0');
    expect(num(12)).toBe('12');
    expect(num(0.5)).toBe('.5');
    expect(num(-0.05)).toBe('-.05');
    expect(num(13.3333)).toBe('13.33');
    expect(num(2.999)).toBe('3');
    expect(formatHundredths(-1234)).toBe('-12.34');
    expect(formatHundredths(1230)).toBe('12.3');
  });
});

describe('glyph outlines', () => {
  it('covers the whole bundled subset (every preset character and more) with one advance per font', () => {
    const presets = [...new Set(Object.values(CHARSET_PRESETS).flatMap((preset) => [...preset]))];
    for (const id of FONTS) {
      const o = outlinesFor(id);
      const keys = new Set(Object.keys(o.glyphs));
      expect(presets.filter((ch) => !keys.has(ch))).toEqual([]);
      // Characters a custom charset may use that the engine draws with the font.
      for (const ch of ['ñ', 'Ñ', '↑', '↓', 'Æ', '€', '™']) expect(keys.has(ch), `${id} ${ch}`).toBe(true);
      expect(keys.size).toBeGreaterThan(200);
      expect(o.glyphs[' ']).toBe('');
      expect(o.advance / o.unitsPerEm).toBeCloseTo(0.6, 3);
    }
  });

  it('places a known glyph exactly: scale fontSize/unitsPerEm, y flipped, pen at the baseline', () => {
    // JetBrains Mono "-" is the rectangle (140..460) × (290..370) in font units.
    const outlines = outlinesFor('jetbrains-mono');
    expect(outlines.glyphs['-']).toBe('M460 290L140 290L140 370L460 370L460 290Z');
    const snap = makeSnapshot({ rows: ['   ', '  -'] });
    const { svg } = snapshotToSvg(snap, { outlines });
    const d = attr(svg, 'path', 'd')[0];
    const s = GEOMETRY.fontSize / 1000;
    const ox = 2 * GEOMETRY.cellW;
    const oy = 1 * GEOMETRY.cellH + GEOMETRY.baseline;
    const expected: Array<[number, number]> = [
      [460, 290],
      [140, 290],
      [140, 370],
      [460, 370],
      [460, 290],
    ].map(([x, y]) => [ox + x * s, oy - y * s]);
    const got = absolutePathPoints(d);
    expect(got).toHaveLength(expected.length);
    got.forEach(([x, y], k) => {
      expect(Math.abs(x - expected[k][0])).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(y - expected[k][1])).toBeLessThanOrEqual(0.005 + 1e-9);
    });
  });

  it('matches opentype.js getPath() for every glyph of every font (≤ 0.01 px)', () => {
    for (const id of FONTS) {
      const font = parseFont(id);
      const outlines = outlinesFor(id);
      const fontSize = 9 / 0.6;
      for (const ch of Object.keys(outlines.glyphs)) {
        const compiled = compileGlyph(outlines.glyphs[ch], fontSize / outlines.unitsPerEm);
        const ref = font
          .charToGlyph(ch)
          .getPath(37, 101, fontSize)
          .commands.filter((c) => c.type !== 'Z')
          .flatMap((c) => {
            const p: Array<[number, number]> = [];
            if ('x1' in c) p.push([c.x1, c.y1]);
            if ('x2' in c) p.push([c.x2, c.y2]);
            if ('x' in c) p.push([c.x, c.y]);
            return p;
          });
        if (!compiled) {
          expect(ref).toHaveLength(0);
          continue;
        }
        const d = `M${(3700 + compiled.x0) / 100} ${(10100 + compiled.y0) / 100}${compiled.rel}`;
        const pts = absolutePathPoints(d);
        // The extractor drops zero-length lines, so compare against the de-duplicated reference.
        const dedup = ref.filter((p, k) => k === 0 || p[0] !== ref[k - 1][0] || p[1] !== ref[k - 1][1]);
        const ours = pts.filter((p, k) => k === 0 || Math.abs(p[0] - pts[k - 1][0]) > 1e-9 || Math.abs(p[1] - pts[k - 1][1]) > 1e-9);
        expect(ours.length, `${id} ${JSON.stringify(ch)}`).toBe(dedup.length);
        ours.forEach(([x, y], k) => {
          expect(Math.abs(x - dedup[k][0]), `${id} ${ch} x`).toBeLessThan(0.01);
          expect(Math.abs(y - dedup[k][1]), `${id} ${ch} y`).toBeLessThan(0.01);
        });
      }
    }
  });
});

describe('snapshotToSvg', () => {
  const outlines = outlinesFor('jetbrains-mono');

  it('sizes the document exactly to the grid plus margins', () => {
    const snap = makeSnapshot({ rows: ['ab', 'cd', 'ef'] });
    const { svg } = snapshotToSvg(snap, { outlines, margin: 5 });
    const w = 2 * 8 + 10;
    const h = 3 * 16 + 10;
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`));
    expect(svg).toContain(`<rect width="${w}" height="${h}" fill="#0b0b0c"/>`);
    assertWellFormedXml(svg);
  });

  it('omits the background when transparent', () => {
    const { svg } = snapshotToSvg(makeSnapshot({ rows: ['ab'] }), { outlines, transparentBackground: true });
    expect(svg).not.toContain('<rect');
  });

  it('mono emits exactly one compound path in the ink colour', () => {
    const { svg } = snapshotToSvg(makeSnapshot({ rows: ['a@b', '#.-'] }), { outlines });
    expect(attr(svg, 'path', 'fill')).toEqual(['#e8e6df']);
    expect(attr(svg, 'path', 'd')[0].match(/M/g)).toHaveLength(6);
    assertWellFormedXml(svg);
  });

  it('colour modes emit one path per distinct colour', () => {
    const snap = makeSnapshot({
      rows: ['aaa', 'bbb'],
      params: { colorMode: 'source' },
      colors: [0xff0000, 0x00ff00, 0xff0000, 0x0000ff, 0x00ff00, 0x0000ff],
    });
    const { svg } = snapshotToSvg(snap, { outlines });
    expect(attr(svg, 'path', 'fill').sort()).toEqual(['#0000ff', '#00ff00', '#ff0000']);
  });

  it('keeps characters the font lacks as text in their cell instead of leaving them blank', () => {
    const snap = makeSnapshot({ rows: ['a←★', '←<b'] });
    const { svg, warnings } = snapshotToSvg(snap, { outlines, margin: 2 });
    assertWellFormedXml(svg);
    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)].map((m) => m.slice(1));
    expect(texts).toEqual([
      [String(2 + GEOMETRY.cellW), String(2 + GEOMETRY.baseline), '←'],
      [String(2 + 2 * GEOMETRY.cellW), String(2 + GEOMETRY.baseline), '★'],
      ['2', String(2 + GEOMETRY.cellH + GEOMETRY.baseline), '←'],
    ]);
    expect(svg).toContain('font-family="&quot;JetBrains Mono&quot;, monospace"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('“←” “★”');
    expect(warnings[0]).not.toMatch(/blank/);
    // Characters with outlines are still paths.
    expect(attr(svg, 'path', 'd').join('')).toContain('M');
  });

  it('text variant: one <text> per row with textLength = cols·cellW, escaped, font embedded', () => {
    const snap = makeSnapshot({ rows: ['<&> ', 'ab  '] });
    const font = { family: 'JetBrains Mono', data: new Uint8Array([1, 2, 3]) };
    const { svg } = snapshotToSvg(snap, { svgText: 'text', font, margin: 2 });
    assertWellFormedXml(svg);
    expect(attr(svg, 'text', 'textLength')).toEqual(['32', '32']);
    expect(attr(svg, 'text', 'lengthAdjust')).toEqual(['spacing', 'spacing']);
    expect(attr(svg, 'text', 'xml:space')).toEqual(['preserve', 'preserve']);
    expect(attr(svg, 'text', 'y')).toEqual(['14', '30']);
    expect(attr(svg, 'text', 'x')).toEqual(['2', '2']);
    expect(svg).toContain('>&lt;&amp;&gt; </text>');
    expect(svg).toContain('src:url(data:font/woff2;base64,AQID)');
    expect(svg).toContain('font-size="13.3333"');
  });

  it('braille → circles at sub-cell centres with r = 0.36·min(cellW/2, cellH/4)', () => {
    // ⠁ = dot (0,0); ⢀ = dot (1,3)
    const snap = makeSnapshot({ rows: ['⠁⢀'], params: { mode: 'braille' } });
    const { svg } = snapshotToSvg(snap, { margin: 1 });
    assertWellFormedXml(svg);
    expect(attr(svg, 'circle', 'cx')).toEqual(['3', '15']);
    expect(attr(svg, 'circle', 'cy')).toEqual(['3', '15']);
    expect(attr(svg, 'circle', 'r')).toEqual(['1.44', '1.44']);
  });

  it('blocks → rects with horizontal runs merged and full cells as one rect', () => {
    const snap = makeSnapshot({ rows: ['██▀ ', '▖▗  '], params: { mode: 'blocks' } });
    const { svg } = snapshotToSvg(snap);
    assertWellFormedXml(svg);
    const rects = [...svg.matchAll(/<rect x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)"\/>/g)].map((m) =>
      m.slice(1).map(Number),
    );
    expect(rects).toEqual([
      [0, 0, 24, 8], // top half of ██▀ merged into one run
      [0, 8, 16, 8], // bottom half of ██
      [0, 24, 4, 8], // ▖ bottom-left
      [12, 24, 4, 8], // ▗ bottom-right
    ]);
  });

  it('blocks two-colour mode fills every quadrant with fg or bg', () => {
    const snap = makeSnapshot({
      rows: ['▌'],
      params: { mode: 'blocks', colorMode: 'source' },
      colors: [0xff0000],
      backgrounds: [0x0000ff],
    });
    const { svg } = snapshotToSvg(snap);
    expect(svg).toContain('<g fill="#ff0000"><rect x="0" y="0" width="4" height="16"/></g>');
    expect(svg).toContain('<g fill="#0000ff"><rect x="4" y="0" width="4" height="16"/></g>');
  });

  it('halftone → circles of area pitch²·coverage on a lattice centred on the grid', () => {
    const tone = new Array<number>(8 * 4).fill(0.5);
    const snap = makeSnapshot({ rows: new Array(4).fill('xxxxxxxx'), params: { mode: 'halftone', halftoneAngle: 0 }, tone });
    const { svg } = snapshotToSvg(snap);
    assertWellFormedXml(svg);
    const radii = attr(svg, 'circle', 'r').map(Number);
    expect(radii.length).toBeGreaterThan(8 * 8);
    for (const r of radii) expect(r).toBeCloseTo(8 * Math.sqrt(0.5 / Math.PI), 2);
    // Grid 64 × 64 px, pitch 8, centre (32, 32): dots sit on multiples of 8.
    expect(attr(svg, 'circle', 'cx').map(Number).every((x) => x % 8 === 0)).toBe(true);
    expect(attr(svg, 'circle', 'cy')).toContain('32');
    const empty = makeSnapshot({ rows: ['xx'], params: { mode: 'halftone' }, tone: [0, 0] });
    expect(snapshotToSvg(empty).svg).not.toContain('<circle');
  });

  it('halftone square / diamond / line shapes become one path per colour', () => {
    for (const halftoneShape of ['square', 'diamond', 'line'] as const) {
      const snap = makeSnapshot({ rows: ['xxxx', 'xxxx'], params: { mode: 'halftone', halftoneShape }, tone: new Array(8).fill(1) });
      const { svg } = snapshotToSvg(snap);
      assertWellFormedXml(svg);
      expect(attr(svg, 'path', 'fill')).toEqual(['#e8e6df']);
    }
  });
});
