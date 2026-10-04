import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { duotoneWeight } from '../../src/engine/rasterCpu';
import { escapeHtml, snapshotToHtml } from '../../src/export/html';
import { makeSnapshot } from './helpers';

const woff2 = new Uint8Array(
  readFileSync(join(__dirname, '../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2')),
);

/** The <pre>'s content without the per-line baseline struts. */
const preBody = (html: string) => (/<pre>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? '').replace(/<i><\/i>/g, '');

describe('snapshotToHtml', () => {
  it('lays out the <pre> with the shared cell geometry', () => {
    const html = snapshotToHtml(makeSnapshot({ rows: ['ab'] }), { margin: 4 });
    expect(html).toMatch(/font-size:13\.333333px/);
    expect(html).toMatch(/letter-spacing:0/);
    expect(html).toMatch(/padding:4px/);
    expect(html).toMatch(/font-variant-ligatures:none/);
    expect(html).toMatch(/"calt" 0/);
    expect(html).toMatch(/background:#0b0b0c/);
  });

  it('embeds the bundled font as a base64 woff2 @font-face', () => {
    const html = snapshotToHtml(makeSnapshot({ rows: ['ab'] }), { font: { family: 'JetBrains Mono', data: woff2 } });
    const m = /src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\("woff2"\)/.exec(html);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], 'base64').equals(Buffer.from(woff2))).toBe(true);
    expect(html).toMatch(/font-family:"JetBrains Mono",ui-monospace,monospace/);
  });

  it('escapes markup characters in the grid and the title', () => {
    const html = snapshotToHtml(makeSnapshot({ rows: ['<&>"'] }), { title: 'a<b>&"c"' });
    expect(preBody(html)).toBe('&lt;&amp;&gt;&quot;');
    expect(html).toContain('<title>a&lt;b&gt;&amp;&quot;c&quot;</title>');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('mono output has no spans and keeps every row exactly cols wide', () => {
    const html = snapshotToHtml(makeSnapshot({ rows: ['a  b', '    ', 'cdef'] }));
    expect(preBody(html)).toBe('a  b\n    \ncdef');
  });

  it('merges runs of equal colour into one span; spaces join neighbouring runs', () => {
    const red = 0xff0000;
    const blue = 0x0000ff;
    const snap = makeSnapshot({
      rows: ['aa bb', ' cc  '],
      params: { colorMode: 'source' },
      colors: [red, red, blue, blue, blue, blue, red, red, red, red],
    });
    const body = preBody(snapshotToHtml(snap));
    expect(body).toBe(
      '<span style="color:#ff0000">aa </span><span style="color:#0000ff">bb</span>\n' +
        '<span style="color:#ff0000"> cc  </span>',
    );
  });

  it('brightens source colours like the raster (max channel → 255, floor 0.25)', () => {
    const snap = makeSnapshot({ rows: ['ab'], params: { colorMode: 'source' }, colors: [0x402010, 0x080808] });
    const body = preBody(snapshotToHtml(snap));
    expect(body).toContain('color:#ff8040');
    // max channel 8 < 0.25·255 → divided by 0.25 instead of brightened to white
    expect(body).toContain('color:#202020');
  });

  it('duotone mixes shadow → ink by the engine’s duotone weight (same colours as the raster)', () => {
    const snap = makeSnapshot({
      rows: ['ab'],
      params: { colorMode: 'duotone', ink: '#ffffff', shadowInk: '#000000' },
      tone: [0, 0.5],
    });
    const body = preBody(snapshotToHtml(snap));
    const grey = Math.round(255 * duotoneWeight(0.5)).toString(16).padStart(2, '0');
    expect(body).toContain('<span style="color:#000000">a</span>');
    expect(body).toContain(`<span style="color:#${grey}${grey}${grey}">b</span>`);
  });

  it('puts every baseline exactly `baseline` px below its row top, rows exactly cellH apart', () => {
    // An empty inline-block strut per line, lowered by cellH − baseline, is the only thing that sizes
    // the line box (line-height 0), so no font-metric rounding is involved.
    const html = snapshotToHtml(makeSnapshot({ rows: ['ab', 'cd'], geometry: { cellH: 19, baseline: 15 } }));
    expect(html).toMatch(/line-height:0;/);
    expect(html).toContain('pre i{display:inline-block;width:0;height:19px;vertical-align:-4px}');
    expect(/<pre>([\s\S]*)<\/pre>/.exec(html)?.[1]).toBe('<i></i>ab\n<i></i>cd');
  });

  it('gives characters the font lacks an exact cell width, so rows stay cols·cellW wide', () => {
    const html = snapshotToHtml(makeSnapshot({ rows: ['a★b'] }), { covered: new Set(['a', 'b']) });
    expect(preBody(html)).toBe('a<span class="u">★</span>b');
    expect(html).toContain('pre .u{display:inline-block;width:8px}');
  });
});

describe('snapshotToHtml: braille, blocks and halftone are drawn as shapes', () => {
  const svgOf = (html: string) => /<svg [^>]*>/.exec(html)?.[0] ?? '';

  for (const [mode, rows] of [
    ['braille', ['⣿⠁', '⠀⢸']],
    ['blocks', ['▀▄', '█ ']],
    ['halftone', ['ab', 'cd']],
  ] as const) {
    it(`${mode}: an <svg> exactly the PNG's 1× size with the engine's shapes and selectable rows`, () => {
      const snap = makeSnapshot({ rows: [...rows], params: { mode }, tone: [1, 0.5, 0.2, 0] });
      const html = snapshotToHtml(snap, { margin: 3, font: { family: 'JetBrains Mono', data: woff2 } });
      const w = 2 * 8 + 6;
      const h = 2 * 16 + 6;
      expect(svgOf(html)).toBe(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
      expect(html).toMatch(/<(circle|rect|path) /);
      // No font glyphs are drawn, so no font is needed.
      expect(html).not.toContain('@font-face');
      const texts = [...html.matchAll(/<text x="3" y="([\d.]+)" textLength="16" lengthAdjust="spacingAndGlyphs">([^<]*)<\/text>/g)];
      expect(texts.map((m) => m[1])).toEqual([String(3 + 12), String(3 + 16 + 12)]);
      expect(texts.every((m) => [...m[2]].length === 2)).toBe(true);
      expect(html).toContain('<g fill="transparent"');
    });
  }

  it('blocks in source colour keep per-cell backgrounds as shapes', () => {
    const snap = makeSnapshot({
      rows: ['▀▀'],
      params: { mode: 'blocks', colorMode: 'source' },
      colors: [0x112233, 0x112233],
      backgrounds: [0x445566, 0x445566],
    });
    const html = snapshotToHtml(snap);
    expect(html).toContain('<g fill="#445566">');
    expect(html).not.toContain('<pre>');
  });
});
