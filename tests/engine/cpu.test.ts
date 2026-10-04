import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, type RenderParams } from '../../src/engine/types';
import { drawGlyph } from '../../src/engine/atlas';
import { analysisSize, gridSize } from '../../src/engine/geometry';
import { analysisLightness, analyzeCpu, createHistory, sampleCells, toSnapshot, type CpuImage } from '../../src/engine/cpu';
import { nearestGlyph } from '../../src/engine/match';
import { IDENTITY_LEVELS, measureLevels, toneConstants } from '../../src/engine/tone';
import { BRAILLE_BITS, QUADRANT_CHARS } from '../../src/engine/charsets';
import { BUILTIN_PRESETS, defaultParams } from '../../src/state/params';
import { factory, FONT_IDS, fixturePath, loadRgba, params, pipeline } from './helpers';

function run(image: CpuImage, p: RenderParams, levels = IDENTITY_LEVELS) {
  const pl = pipeline(p);
  const result = analyzeCpu(image, p, levels, pl.geometry, pl.glyphSet, pl.taps);
  return { ...pl, result, snapshot: toSnapshot(result, pl.glyphSet, p, pl.geometry) };
}

/** Opaque grey image from a lightness function of normalised (x, y). */
function synth(width: number, height: number, f: (x: number, y: number) => number): CpuImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(Math.min(1, Math.max(0, f(x / (width - 1), y / (height - 1)))) * 255);
      rgba.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { rgba, width, height };
}

function topShare(chars: string[]): [string, number] {
  const counts = new Map<string, number>();
  let ink = 0;
  for (const c of chars) {
    if (c === ' ') continue;
    ink++;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const [ch, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return [ch, n / ink];
}

describe('§9.1 round trip', () => {
  // Scale 4 is the atlas's own resolution, so drawing and analysis go through identical pixels.
  // Smaller text is rasterised differently (hinting and stem darkening at ~13 px make strokes
  // heavier and snap them to whole pixels), which no analysis can undo.
  it.each([
    [4, 0.98],
    [2, 0.9],
  ])('recovers random glyphs drawn at baseline (scale %i, ≥ %d)', (scale, minRate) => {
    const p = params({ shapeSharpness: 1, edgeSharpness: 1, dither: 0, autoLevels: false });
    const { geometry, taps, glyphSet } = pipeline(p);
    const cols = 60;
    const rows = 24;
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const text = Array.from({ length: cols * rows }, () => glyphSet.chars[Math.floor(rand() * glyphSet.chars.length)]);
    const cw = geometry.cellW * scale;
    const ch = geometry.cellH * scale;
    const width = cols * cw;
    const height = rows * ch;
    const { ctx } = factory(width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    text.forEach((c, i) => {
      drawGlyph(ctx, c, (i % cols) * cw, Math.floor(i / cols) * ch + geometry.baseline * scale, geometry.fontSize * scale, geometry.fontFamily);
    });
    const image = { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
    const grid = gridSize(image.width, image.height, cols, geometry);
    expect(grid).toEqual({ cols, rows });
    const size = analysisSize(grid, geometry);
    const L = analysisLightness(image, size, toneConstants(p, IDENTITY_LEVELS));
    const circles = sampleCells(L, size, grid, taps.internal);
    // Compare in glyph space (each component over its glyph-set maximum): in tone space (q·W) a
    // drawn glyph is just a grey patch, which is what the anchor is for.
    const q = new Float64Array(6);
    let hits = 0;
    for (let cell = 0; cell < cols * rows; cell++) {
      for (let k = 0; k < 6; k++) q[k] = circles[cell * 6 + k] / glyphSet.componentMax[k];
      if (glyphSet.chars[nearestGlyph(q, glyphSet)] === text[cell]) hits++;
    }
    const rate = hits / (cols * rows);
    console.log(`round trip at scale ${scale}: ${(rate * 100).toFixed(2)} %`);
    expect(rate).toBeGreaterThanOrEqual(minRate);
  });
});

describe('§9.2 ramp', () => {
  /** Per-column mean displayed ink and the set of columns each glyph appears in. */
  function rampColumns(dither: number) {
    // 160 columns × 64 rows: a whole number of 4×4 dither periods.
    const image = synth(1280, 1024, (x) => x);
    const { result, glyphSet } = run(image, params({ mode: 'ramp', columns: 160, dither, autoLevels: false }));
    const { cols, rows } = result.grid;
    const ink: number[] = [];
    const columnsOf = new Map<number, Set<number>>();
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let r = 0; r < rows; r++) {
        const g = result.indices[r * cols + c];
        s += glyphSet.meanCoverage[g];
        if (!columnsOf.has(g)) columnsOf.set(g, new Set());
        columnsOf.get(g)!.add(c);
      }
      ink.push(s / rows);
    }
    return { cols, ink, columnsOf };
  }

  it('a horizontal 0→1 gradient gives non-decreasing ink, ≥ 7 glyphs, none on > 35 % of columns', () => {
    const { cols, ink, columnsOf } = rampColumns(0);
    for (let c = 1; c < cols; c++) expect(ink[c]).toBeGreaterThanOrEqual(ink[c - 1] - 0.02);
    expect(columnsOf.size).toBeGreaterThanOrEqual(7);
    for (const set of columnsOf.values()) expect(set.size / cols).toBeLessThanOrEqual(0.35);
  });

  it('with the default dither the ink is non-decreasing over 8-column windows', () => {
    const { cols, ink, columnsOf } = rampColumns(DEFAULT_PARAMS.dither);
    const window = (c: number) => ink.slice(c, c + 8).reduce((a, b) => a + b, 0) / 8;
    for (let c = 8; c + 7 < cols; c += 8) expect(window(c)).toBeGreaterThanOrEqual(window(c - 8) - 0.02);
    expect(columnsOf.size).toBeGreaterThanOrEqual(7);
  });

  // tone-only matching against all 95 ASCII glyphs read as random letters.
  it('Full ASCII ramps through the classic tonal ramp only, from paper to its densest glyph', () => {
    const image = synth(1280, 1024, (x) => x);
    const { result, glyphSet } = run(image, params({ mode: 'ramp', charsetPreset: 'ascii', columns: 160, dither: 0, autoLevels: false }));
    const used = new Set(Array.from(result.indices, (g) => glyphSet.atlasChars[g]));
    for (const ch of used) expect(' .:-=+*#%@').toContain(ch);
    expect(used.size).toBeGreaterThanOrEqual(8);
    const last = result.indices[result.grid.cols - 1];
    expect(glyphSet.meanCoverage[last]).toBeCloseTo(glyphSet.rampAnchor, 6);
  });
});

describe('§9.3 locality', () => {
  it('a small bright patch changes no cell more than 2 cells away', async () => {
    const base = await loadRgba(fixturePath('terrain_640x360.png'));
    const p = params({ columns: 80, autoLevels: false });
    const before = run(base, p).result;
    const patched = new Uint8ClampedArray(base.rgba);
    const [px, py] = [200, 260];
    for (let y = py; y < py + 3; y++) for (let x = px; x < px + 3; x++) patched.set([255, 255, 255, 255], (y * base.width + x) * 4);
    const after = run({ ...base, rgba: patched }, p).result;
    const { cols, rows } = before.grid;
    const pc = Math.floor((px / base.width) * cols);
    const pr = Math.floor((py / base.height) * rows);
    let changed = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (before.indices[r * cols + c] === after.indices[r * cols + c]) continue;
        changed++;
        expect(Math.max(Math.abs(r - pr), Math.abs(c - pc))).toBeLessThanOrEqual(2);
      }
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('§9.4 determinism', () => {
  it.each(['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const)('%s: two runs are byte-identical', async (mode) => {
    const image = await loadRgba(fixturePath('waves_600x400.png'));
    const levels = measureLevels(image.rgba, image.width, image.height);
    const p = params({ mode, colorMode: mode === 'blocks' ? 'source' : 'mono', ditherPattern: 'noise' });
    const a = run(image, p, levels).result;
    const b = run({ ...image, rgba: new Uint8ClampedArray(image.rgba) }, { ...p }, { ...levels }).result;
    expect(Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer))).toBe(true);
    expect(Buffer.from(a.tone.buffer).equals(Buffer.from(b.tone.buffer))).toBe(true);
    expect(Buffer.from(a.colors).equals(Buffer.from(b.colors))).toBe(true);
  });
});

describe('§9.6 modes', () => {
  // 20 cells wide at 8×16 px: the image maps 1:1 onto the analysis grid.
  const cellImage = (cols: number, rows: number, lit: (col: number, row: number, x: number, y: number) => boolean): CpuImage => {
    const width = cols * 8;
    const height = rows * 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = lit(Math.floor(x / 8), Math.floor(y / 16), x % 8, y % 16) ? 255 : 0;
        rgba.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return { rgba, width, height };
  };

  it('braille: each dot sets its own bit and character', () => {
    const dots: [number, number][] = [];
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) dots.push([dx, dy]);
    const image = cellImage(20, 10, (col, _row, x, y) => col < 8 && Math.floor(x / 4) === dots[col][0] && Math.floor(y / 4) === dots[col][1]);
    const { result, snapshot } = run(image, params({ mode: 'braille', columns: 20, ditherPattern: 'none' }));
    dots.forEach(([dx, dy], col) => {
      expect(result.indices[col]).toBe(BRAILLE_BITS[dy][dx]);
      expect(snapshot.chars[col]).toBe(String.fromCharCode(0x2800 + BRAILLE_BITS[dy][dx]));
    });
    expect(result.indices[10]).toBe(0);
    expect(snapshot.chars[10]).toBe('⠀');
  });

  it('blocks: every quadrant pattern maps to its block element', () => {
    const image = cellImage(20, 10, (col, _row, x, y) => col < 16 && ((col >> ((y >> 3) * 2 + (x >> 2))) & 1) === 1);
    const { result, snapshot } = run(image, params({ mode: 'blocks', columns: 20, ditherPattern: 'none' }));
    for (let bits = 0; bits < 16; bits++) {
      expect(result.indices[bits]).toBe(bits);
      expect(snapshot.chars[bits]).toBe(QUADRANT_CHARS[bits]);
    }
  });

  it('blocks colour mode fits two colours per cell, the inkier side as foreground', () => {
    const width = 160;
    const height = 160;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) rgba.set(y % 16 < 8 ? [250, 40, 30, 255] : [20, 30, 120, 255], (y * width + x) * 4);
    }
    const { result, snapshot } = run({ rgba, width, height }, params({ mode: 'blocks', colorMode: 'source', columns: 20, autoLevels: false }));
    expect(snapshot.chars[0]).toBe('▀');
    expect(Array.from(result.colors.subarray(0, 3))).toEqual([250, 40, 30]);
    expect(Array.from(result.backgrounds!.subarray(0, 3))).toEqual([20, 30, 120]);
  });

  it('halftone coverage is monotone in lightness and tracks it', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = i / 20;
      const { result } = run(synth(160, 160, () => v), params({ mode: 'halftone', columns: 20, autoLevels: false }));
      const c = result.tone[0];
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeCloseTo(Math.round(v * 255) / 255, 3);
      prev = c;
    }
  });
});

describe('§9.7 polarity', () => {
  it('dark ink on light paper renders the negative of an image like light ink on dark paper renders it', async () => {
    const img = await loadRgba(fixturePath('torus_450.png'));
    const neg = new Uint8ClampedArray(img.rgba);
    for (let i = 0; i < neg.length; i += 4) for (let c = 0; c < 3; c++) neg[i + c] = 255 - neg[i + c];
    for (const mode of ['shape', 'ramp', 'braille'] as const) {
      for (const autoLevels of [false, true]) {
        const light = params({ mode, autoLevels, ink: '#ffffff', paper: '#000000' });
        const dark = params({ mode, autoLevels, ink: '#000000', paper: '#ffffff' });
        const a = run(img, light, measureLevels(img.rgba, img.width, img.height)).snapshot.chars;
        const b = run({ ...img, rgba: neg }, dark, measureLevels(neg, img.width, img.height)).snapshot.chars;
        const same = a.filter((c, i) => c === b[i]).length / a.length;
        expect(same, `${mode} autoLevels=${autoLevels}`).toBeGreaterThanOrEqual(0.999);
      }
    }
  });

  it('transparent pixels are paper: a logo renders blank around it on either paper', async () => {
    const img = await loadRgba(fixturePath('logo_rgba_256.png'));
    for (const [ink, paper] of [
      ['#ffffff', '#000000'],
      ['#000000', '#ffffff'],
    ]) {
      const { snapshot } = run(img, params({ ink, paper, columns: 40 }), measureLevels(img.rgba, img.width, img.height));
      expect(snapshot.chars[0]).toBe(' ');
      expect(snapshot.chars[snapshot.chars.length - 1]).toBe(' ');
      expect(snapshot.chars.some((c) => c !== ' ')).toBe(true);
    }
  });
});

describe('real fixtures (default params)', () => {
  it.each(['torus_450.png', 'terrain_640x360.png'])('%s: no glyph covers more than 40 percent of the inked cells', async (name) => {
    const img = await loadRgba(fixturePath(name));
    const { snapshot } = run(img, params(), measureLevels(img.rgba, img.width, img.height));
    const [ch, share] = topShare(snapshot.chars);
    console.log(`${name}: most common glyph ${JSON.stringify(ch)} on ${(share * 100).toFixed(1)} % of inked cells`);
    expect(share).toBeLessThanOrEqual(0.4);
  });

  it('stays under 40 percent for every font and line height (torus, terrain, waves)', async () => {
    for (const name of ['torus_450.png', 'terrain_640x360.png', 'waves_600x400.png']) {
      const img = await loadRgba(fixturePath(name));
      const levels = measureLevels(img.rgba, img.width, img.height);
      for (const font of FONT_IDS) {
        for (const lineHeight of [1.0, 1.2, 1.5]) {
          const [ch, share] = topShare(run(img, params({ font, lineHeight }), levels).snapshot.chars);
          expect(share, `${name} ${font} lh ${lineHeight}: ${JSON.stringify(ch)}`).toBeLessThanOrEqual(0.4);
        }
      }
    }
  });

  it('terrain: the sun gets more ink than the sky around it', async () => {
    const img = await loadRgba(fixturePath('terrain_640x360.png'));
    const { snapshot, glyphSet } = run(img, params(), measureLevels(img.rgba, img.width, img.height));
    const { cols, rows, tone } = snapshot;
    const ink = (i: number) => glyphSet.meanCoverage[glyphSet.chars.indexOf(snapshot.chars[i])];
    // The sun: the brightest cells; the sky: the ring 1.5–3 sun radii around its centre, above the hills.
    let sx = 0;
    let sy = 0;
    const sun: number[] = [];
    for (let i = 0; i < tone.length; i++) {
      if (tone[i] > 0.9) {
        sun.push(i);
        sx += i % cols;
        sy += Math.floor(i / cols);
      }
    }
    expect(sun.length).toBeGreaterThan(10);
    sx /= sun.length;
    sy /= sun.length;
    expect(sx / cols).toBeGreaterThan(0.5);
    expect(sy / rows).toBeLessThan(0.5);
    const radius = Math.sqrt(sun.length / Math.PI);
    const sky: number[] = [];
    for (let i = 0; i < tone.length; i++) {
      const dx = (i % cols) - sx;
      const dy = (Math.floor(i / cols) - sy) * 2; // cells are twice as tall as wide
      const d = Math.hypot(dx, dy) / 2;
      if (d > 1.5 * radius && d < 3 * radius && Math.floor(i / cols) < rows * 0.4) sky.push(i);
    }
    const mean = (ids: number[]) => ids.reduce((s, i) => s + ink(i), 0) / ids.length;
    console.log(`terrain: sun ink ${mean(sun).toFixed(3)} (${sun.length} cells) vs sky ink ${mean(sky).toFixed(3)} (${sky.length} cells)`);
    expect(mean(sun)).toBeGreaterThan(mean(sky) * 1.5);
  });
});

describe('render quality regressions', () => {
  /** Share of horizontal a, b, a triples (a ≠ b) among inked neighbours: the ABAB hatching an ordered dither draws on gradients. */
  const ababShare = (chars: string[], cols: number) => {
    let n = 0;
    let k = 0;
    for (let i = 0; i + 2 < chars.length; i++) {
      if (i % cols > cols - 3 || chars[i] === ' ' || chars[i + 1] === ' ') continue;
      n++;
      if (chars[i] === chars[i + 2] && chars[i] !== chars[i + 1]) k++;
    }
    return k / n;
  };

  it('the default dither does not hatch smooth gradients', async () => {
    for (const name of ['gradient_512x64.png', 'terrain_640x360.png']) {
      const img = await loadRgba(fixturePath(name));
      const { snapshot } = run(img, params(), measureLevels(img.rgba, img.width, img.height));
      const share = ababShare(snapshot.chars, snapshot.cols);
      console.log(`${name}: ABAB share ${share.toFixed(3)}`);
      // The 4×4 Bayer dither at 0.1 measured 0.54 (gradient) and 0.38 (terrain); blue noise at the
      // default 0.05 measures 0.13 and 0.08, aperiodic grain rather than hatching. (0.03 would halve
      // it again but leaves 77 % of the gradient in flat bands of 8+ cells, against 63 %.)
      expect(share).toBeLessThan(0.15);
    }
  });

  it('no preset inks a pure-black background', async () => {
    const img = await loadRgba(fixturePath('torus_450.png'));
    const levels = measureLevels(img.rgba, img.width, img.height);
    for (const preset of BUILTIN_PRESETS) {
      for (const dither of [preset.params.dither ?? DEFAULT_PARAMS.dither, 0.5]) {
        const p = { ...defaultParams('a'), ...preset.params, dither, columns: 120 };
        const { snapshot } = run(img, p, levels);
        const { cols, rows } = snapshot;
        let black = 0;
        let inked = 0;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            // Cells whose source pixels are all pure black.
            let max = 0;
            const x0 = Math.floor((col * img.width) / cols);
            const x1 = Math.ceil(((col + 1) * img.width) / cols);
            const y0 = Math.floor((row * img.height) / rows);
            const y1 = Math.ceil(((row + 1) * img.height) / rows);
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) max = Math.max(max, img.rgba[(y * img.width + x) * 4 + c]);
            if (max > 0) continue;
            black++;
            const ch = snapshot.chars[row * cols + col];
            if (ch !== ' ' && ch !== '\u2800') inked++;
          }
        }
        expect(black).toBeGreaterThan(100);
        expect(inked / black, `${preset.name} at dither ${dither}`).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('a transparent logo keeps its darker colour and its transparent area stays paper', async () => {
    // White ring and a #1E90FF bar on transparency, like the corpus logo.
    const w = 240;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - w / 2, y - w / 2);
        const bar = Math.abs(x - w / 2) < 10 && y > 20 && y < w - 20;
        const ring = r > 60 && r < 100;
        rgba.set(bar ? [30, 144, 255, 255] : ring ? [255, 255, 255, 255] : [0, 0, 0, 0], (y * w + x) * 4);
      }
    }
    const img = { rgba, width: w, height: w };
    const levels = measureLevels(rgba, w, w);
    for (const patch of [{}, { invert: true }, { brightness: 0.3 }, { contrast: 0.6 }, { paper: '#f4f1ea', ink: '#151515' }, { autoLevels: false }]) {
      for (const mode of ['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const) {
        const { snapshot } = run(img, params({ ...defaultParams('a'), mode, columns: 60, ...patch }), levels);
        const at = (fx: number, fy: number) => snapshot.chars[Math.floor(fy * snapshot.rows) * snapshot.cols + Math.floor(fx * snapshot.cols)];
        const label = `${mode} ${JSON.stringify(patch)}`;
        // Corners and the ring's hole are transparent.
        for (const [fx, fy] of [[0.02, 0.02], [0.97, 0.97], [0.4, 0.5]]) expect([' ', '\u2800'], label).toContain(at(fx, fy));
        // The bar (luma 0.50) is inked unless the paper is light (then the white ring is paper and the bar is ink anyway).
        expect([' ', '\u2800'], `${label}: bar`).not.toContain(at(0.5, 0.15));
      }
    }
  });
});

describe('§8 stability', () => {
  const frames = async () => {
    const img = await loadRgba(fixturePath('waves_600x400.png'));
    let seed = 3;
    const noisy = new Uint8ClampedArray(img.rgba);
    for (let i = 0; i < noisy.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const n = ((seed >>> 16) % 13) - 6;
      for (let c = 0; c < 3; c++) noisy[i + c] = Math.min(255, Math.max(0, noisy[i + c] + n));
    }
    return { img, noisy: { ...img, rgba: noisy } };
  };

  it('damps flicker from sensor-like noise and still lets a cut through', async () => {
    const { img, noisy } = await frames();
    const levels = measureLevels(img.rgba, img.width, img.height);
    const p = params({ stability: 0.8 });
    const { geometry, taps, glyphSet } = pipeline(p);
    const plain = (im: CpuImage) => analyzeCpu(im, p, levels, geometry, glyphSet, taps).indices;
    const diff = (a: Uint16Array, b: Uint16Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

    const flickerWithout = diff(plain(img), plain(noisy));
    const history = createHistory();
    const first = analyzeCpu(img, p, levels, geometry, glyphSet, taps, { history }).indices;
    expect(diff(first, plain(img))).toBe(0);
    const second = analyzeCpu(noisy, p, levels, geometry, glyphSet, taps, { history }).indices;
    expect(diff(first, second)).toBeLessThan(flickerWithout * 0.5);

    // A hard cut changes the circle means by far more than 1/4, so it passes straight through.
    const cut = synth(img.width, img.height, (x, y) => (Math.floor(x * 9) + Math.floor(y * 5)) % 2);
    const afterCut = analyzeCpu(cut, p, levels, geometry, glyphSet, taps, { history }).indices;
    console.log(`stability: ${flickerWithout} → ${diff(first, second)} flickering cells; ${diff(afterCut, plain(cut))} differ after a cut`);
    expect(diff(afterCut, plain(cut)) / afterCut.length).toBeLessThan(0.05);
  });
});

describe('§8 hysteresis for thresholded modes', () => {
  it.each([
    ['braille', {}],
    ['braille', { ditherPattern: 'noise' }],
    ['blocks', {}],
    ['blocks', { colorMode: 'source' }],
  ] as const)('%s %j: a static noisy clip stops twinkling, a cut still passes', async (mode, extra) => {
    const img = await loadRgba(fixturePath('terrain_640x360.png'));
    const levels = measureLevels(img.rgba, img.width, img.height);
    const noisy = (f: number): CpuImage => {
      const rgba = new Uint8ClampedArray(img.rgba);
      let seed = 101 + f * 7919;
      for (let i = 0; i < rgba.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const n = ((seed >>> 16) % 13) - 6;
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.max(0, rgba[i + c] + n));
      }
      return { ...img, rgba };
    };
    const flicker = (stability: number) => {
      const p = params({ mode, stability, ...extra });
      const { geometry, glyphSet, taps } = pipeline(p);
      const history = createHistory();
      let prev: Uint16Array | null = null;
      let changed = 0;
      for (let f = 0; f < 8; f++) {
        const idx = analyzeCpu(noisy(f), p, levels, geometry, glyphSet, taps, { history }).indices;
        if (prev) changed += idx.reduce((n, v, i) => n + (v !== prev![i] ? 1 : 0), 0) / idx.length;
        prev = idx;
      }
      // A cut to a different picture: the hysteresis band is far smaller than real changes. Small
      // changes (a dark area staying dark) are smoothed over a frame, so compare the second frame.
      const cut = synth(img.width, img.height, (x, y) => (Math.floor(x * 9) + Math.floor(y * 5)) % 2);
      analyzeCpu(cut, p, levels, geometry, glyphSet, taps, { history });
      const after = analyzeCpu(cut, p, levels, geometry, glyphSet, taps, { history }).indices;
      const plain = analyzeCpu(cut, p, levels, geometry, glyphSet, taps).indices;
      return { perFrame: changed / 7, cutMismatch: after.reduce((n, v, i) => n + (v !== plain[i] ? 1 : 0), 0) / after.length };
    };
    const off = flicker(0);
    const on = flicker(DEFAULT_PARAMS.stability);
    console.log(`${mode} ${JSON.stringify(extra)}: ${(100 * off.perFrame).toFixed(2)} % → ${(100 * on.perFrame).toFixed(2)} % cells change per frame`);
    expect(on.perFrame).toBeLessThan(0.002);
    expect(on.perFrame).toBeLessThan(off.perFrame / 5);
    expect(on.cutMismatch).toBeLessThan(0.05);
  });
});

describe('performance', () => {
  // Skipped on CI: the 60 ms budget is calibrated on a developer machine (≈ 43 ms on an Apple M5 at
  // rest), and shared CI runners are several times slower and noisy, so there it would measure the
  // runner rather than a regression. Run it locally after touching the CPU analysis.
  it.skipIf(!!process.env.CI)('analyses a 160 × 90 grid in well under the frame budget', () => {
    const image = synth(1280, 1440, (x, y) => 0.5 + 0.5 * Math.sin(12 * x + 7 * y) * Math.cos(9 * y));
    const p = params({ columns: 160 });
    const { geometry, taps, glyphSet } = pipeline(p);
    expect(gridSize(image.width, image.height, 160, geometry)).toEqual({ cols: 160, rows: 90 });
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      analyzeCpu(image, p, IDENTITY_LEVELS, geometry, glyphSet, taps);
      times.push(performance.now() - t0);
    }
    const median = times.sort((a, b) => a - b)[3];
    console.log(`160×90 shape analysis: median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(60);
  });
});
