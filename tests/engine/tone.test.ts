import { describe, expect, it } from 'vitest';
import { bayer8, BLUE_NOISE_SIZE, blueNoise64, toneDither } from '../../src/engine/dither';
import { effectiveLevels, IDENTITY_LEVELS, measureLevels, polarityInvert, toneConstants, toneMap, toneMapPlane } from '../../src/engine/tone';
import { fixturePath, loadRgba, params } from './helpers';

describe('toneMap (§3)', () => {
  it('applies levels, contrast/brightness, gamma and polarity in order', () => {
    const t = toneConstants(params({ gamma: 2, contrast: 1, brightness: 0 }), { black: 0.2, white: 0.6 });
    expect(toneMap(0.4, 1, t)).toBeCloseTo(0.25, 12); // (0.4−0.2)/0.4 = 0.5, squared
    expect(toneMap(0.1, 1, t)).toBe(0);
    expect(toneMap(0.9, 1, t)).toBe(1);
    const c = toneConstants(params({ contrast: 2, brightness: 0.1 }), IDENTITY_LEVELS);
    expect(toneMap(0.6, 1, c)).toBeCloseTo(0.8, 12);
  });

  it('transparency is paper (tone 0) whatever the paper, levels, tone settings or Invert', () => {
    const variants = [
      params({ paper: '#000000', ink: '#ffffff' }),
      params({ paper: '#0b0b0c', ink: '#e6e4df', brightness: 0.3 }),
      params({ paper: '#0b0b0c', ink: '#e6e4df', contrast: 0.6 }),
      params({ paper: '#0b0b0c', ink: '#e6e4df', invert: true }),
      params({ paper: '#f4f1ea', ink: '#151515' }),
      params({ paper: '#f4f1ea', ink: '#151515', invert: true, gamma: 0.5 }),
    ];
    for (const p of variants) {
      for (const levels of [IDENTITY_LEVELS, { black: 0, white: 0.1 }, { black: 0.5, white: 1 }]) {
        expect(toneMap(0, 0, toneConstants(p, levels)), JSON.stringify([p.paper, levels])).toBe(0);
      }
    }
  });

  it('a half-transparent pixel gets half the ink of its visible colour', () => {
    for (const p of [params({ paper: '#000000', ink: '#ffffff' }), params({ paper: '#ffffff', ink: '#000000' }), params({ invert: true, brightness: 0.2 })]) {
      const t = toneConstants(p, IDENTITY_LEVELS);
      // A 60 % grey at alpha 0.5 averages to premultiplied luma 0.3.
      expect(toneMap(0.3, 0.5, t)).toBeCloseTo(0.5 * toneMap(0.6, 1, t), 12);
    }
  });

  it('polarity = invert XOR (ink darker than paper)', () => {
    expect(polarityInvert(params({ ink: '#ffffff', paper: '#000000', invert: false }))).toBe(false);
    expect(polarityInvert(params({ ink: '#000000', paper: '#ffffff', invert: false }))).toBe(true);
    expect(polarityInvert(params({ ink: '#000000', paper: '#ffffff', invert: true }))).toBe(false);
  });

  it('levels are only applied when autoLevels is on', () => {
    const lv = { black: 0.3, white: 0.4 };
    expect(effectiveLevels(params({ autoLevels: false }), lv)).toEqual(IDENTITY_LEVELS);
    expect(effectiveLevels(params({ autoLevels: true }), lv)).toEqual(lv);
  });
});

describe('measureLevels', () => {
  it('finds p1 / p99 of a horizontal gradient', async () => {
    const img = await loadRgba(fixturePath('gradient_512x64.png'));
    const { black, white } = measureLevels(img.rgba, img.width, img.height);
    expect(black).toBeLessThan(0.05);
    expect(white).toBeGreaterThan(0.95);
  });

  /** w × w image: each pixel's [r, g, b, a] from its index. */
  const image = (w: number, px: (i: number) => number[]) => {
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) rgba.set(px(i), i * 4);
    return rgba;
  };

  it('ignores transparent pixels and keeps a flat image at its own level', () => {
    for (const v of [51, 128, 204]) {
      const lv = measureLevels(image(64, (i) => (i % 64 < 32 ? [v, v, v, 255] : [255, 255, 255, 0])), 64, 64);
      const t = toneConstants(params({ ink: '#ffffff', paper: '#000000' }), lv);
      expect(toneMap(v / 255, 1, t), `grey ${v}`).toBeCloseTo(v / 255, 6);
    }
  });

  it('never turns a flat colour of a graphic into paper (a logo’s darker colour)', () => {
    // 82 % white, 18 % #1E90FF (luma 0.50) on transparency: the blue must keep its level.
    const lv = measureLevels(image(100, (i) => (i % 100 < 18 ? [30, 144, 255, 255] : i % 100 < 60 ? [255, 255, 255, 255] : [0, 0, 0, 0])), 100, 100);
    expect(lv).toEqual(IDENTITY_LEVELS);
  });

  it('still maps a dark flat background to paper and stretches the picture on it', () => {
    // 40 % flat backdrop at luma 0.12, the rest a gradient 0.3..0.9.
    const lv = measureLevels(image(100, (i) => {
      if (i % 100 < 40) return [31, 31, 31, 255];
      const v = Math.round(255 * (0.3 + (0.6 * ((i % 100) - 40)) / 59));
      return [v, v, v, 255];
    }), 100, 100);
    expect(lv.black).toBeCloseTo(31 / 255, 2);
    expect(lv.white).toBeLessThan(0.95);
  });

  it('a negative image gets mirrored levels', () => {
    const n = 300;
    const rgba = new Uint8ClampedArray(n * 4);
    const neg = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = (i * 97) % 256;
      rgba.set([v, v, v, 255], i * 4);
      neg.set([255 - v, 255 - v, 255 - v, 255], i * 4);
    }
    const a = measureLevels(rgba, n, 1);
    const b = measureLevels(neg, n, 1);
    expect(b.black).toBeCloseTo(1 - a.white, 6);
    expect(b.white).toBeCloseTo(1 - a.black, 6);
  });
});

describe('dither patterns', () => {
  it('the tone dither never leaves [0, 1], keeps black and white exact and adds no ink on average', () => {
    for (const amount of [0, 0.05, 0.15, 0.5]) {
      expect(toneDither(0, 0.99, amount)).toBe(0);
      expect(toneDither(1, 0.01, amount)).toBe(1);
      for (let step = 0; step <= 100; step++) {
        const t = step / 100;
        let mean = 0;
        for (let i = 0; i < 64; i++) {
          const v = toneDither(t, (i + 0.5) / 64, amount);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
          mean += v / 64;
        }
        expect(mean).toBeCloseTo(t, 12);
      }
    }
  });

  it('bayer8 is a permutation of 0..63 with the recursive structure', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(bayer8(x, y) * 64 - 0.5);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(bayer8(0, 0) * 64 - 0.5).toBe(0);
    expect(bayer8(4, 4) * 64 - 0.5).toBe(1);
  });

  it('the blue-noise tile is a deterministic permutation with little low-frequency energy', () => {
    const tile = blueNoise64();
    const n = BLUE_NOISE_SIZE;
    const ranks = Array.from(tile, (v) => Math.round(v * n * n - 0.5)).sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: n * n }, (_, i) => i));
    // Blue noise: 8×8 block means stay much closer to 0.5 than white noise's (σ ≈ 0.036).
    let worst = 0;
    for (let by = 0; by < n; by += 8) {
      for (let bx = 0; bx < n; bx += 8) {
        let s = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += tile[(by + y) * n + bx + x];
        worst = Math.max(worst, Math.abs(s / 64 - 0.5));
      }
    }
    expect(worst).toBeLessThan(0.04);
  });
});

describe('toneMapPlane', () => {
  it('matches toneMap exactly', () => {
    const t = toneConstants(params({ gamma: 0.7, contrast: 1.3, brightness: -0.1, ink: '#000000', paper: '#f0e0d0' }), { black: 0.1, white: 0.8 });
    const la = new Float32Array(2000).map((_, i) => (i % 2 ? (i % 7) / 6 : ((i * 13) % 101) / 100));
    const out = toneMapPlane(la, new Float32Array(1000), t);
    for (let i = 0; i < 1000; i++) expect(out[i]).toBe(Math.fround(toneMap(la[i * 2], la[i * 2 + 1], t)));
  });
});
