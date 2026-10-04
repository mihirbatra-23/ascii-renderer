import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compositeStep, decodeGif, GifCompositor, type DecodedGif } from '../../src/media/gif-core';
import { hasTransparentPixel } from '../../src/media/rgba';
import { MediaError } from '../../src/media/types';
import { writeGif, type Rgb, type TestFrame } from './helpers/gif-writer';

const FIXTURES = join(__dirname, '..', 'fixtures');
const CORPUS = process.env.MEDIA_CORPUS_DIR ?? process.env.ASCII_CORPUS_DIR ?? '';

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];
const PALETTE: Rgb[] = [RED, GREEN, BLUE, WHITE];

const fill = (w: number, h: number, index: number) => new Array<number>(w * h).fill(index);

/** Composites frames 0..last sequentially with the pure step function. */
function compositeAll(gif: DecodedGif): Uint8ClampedArray[] {
  const state = new Uint8ClampedArray(gif.width * gif.height * 4);
  return gif.frames.map((frame) => {
    const out = new Uint8ClampedArray(state.length);
    compositeStep(state, out, gif.width, gif.height, frame, frame.decodeIndices());
    return out;
  });
}

function pixel(rgba: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return Array.from(rgba.subarray(i, i + 4));
}

const opaque = (rgb: Rgb) => [...rgb, 255];
const CLEAR = [0, 0, 0, 0];

function gifOf(frames: TestFrame[], extra: { loop?: number; width?: number; height?: number } = {}): DecodedGif {
  return decodeGif(writeGif({ width: extra.width ?? 4, height: extra.height ?? 4, globalPalette: PALETTE, loop: extra.loop, frames }));
}

describe('decodeGif', () => {
  it('reads frame rects, palettes and transparency', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 0) },
      { left: 1, top: 2, width: 2, height: 1, indices: [1, 2], transparentIndex: 3, localPalette: [WHITE, BLUE, GREEN] },
    ]);
    expect(gif.width).toBe(4);
    expect(gif.frames).toHaveLength(2);
    const f = gif.frames[1];
    expect([f.left, f.top, f.width, f.height]).toEqual([1, 2, 2, 1]);
    expect(Array.from(f.decodeIndices())).toEqual([1, 2]);
    expect(f.transparentIndex).toBe(3);
    expect(Array.from(f.palette!.subarray(0, 9))).toEqual([...WHITE, ...BLUE, ...GREEN]);
    expect(gif.frames[0].transparentIndex).toBe(-1);
  });

  it('applies browser delay clamping (≤ 10 ms → 100 ms)', () => {
    const gif = gifOf([0, 1, 2, 5, 7].map((delayCs) => ({ width: 1, height: 1, indices: [0], delayCs })));
    expect(gif.frames.map((f) => f.delayMs)).toEqual([100, 100, 20, 50, 70]);
  });

  it('treats a frame without a graphic control extension as 100 ms, no disposal, opaque', () => {
    const gif = gifOf([{ width: 1, height: 1, indices: [0], noGce: true }]);
    expect(gif.frames[0]).toMatchObject({ delayMs: 100, disposal: 0, transparentIndex: -1 });
  });

  it.each([
    [undefined, 1],
    [0, 0],
    [1, 2],
    [3, 4],
  ])('NETSCAPE loop %s → loopCount %s (total plays, 0 = forever)', (loop, expected) => {
    expect(gifOf([{ width: 1, height: 1, indices: [0] }], { loop }).loopCount).toBe(expected);
  });

  it('deinterlaces interlaced frames', () => {
    const width = 3;
    const height = 11;
    const indices = Array.from({ length: width * height }, (_, i) => Math.floor(i / width) % 4);
    const gif = gifOf([{ width, height, indices, interlaced: true }], { width, height });
    expect(Array.from(gif.frames[0].decodeIndices())).toEqual(indices);
  });

  it('rejects files with no frames and garbage', () => {
    const empty = writeGif({ width: 2, height: 2, globalPalette: PALETTE, frames: [] });
    expect(() => decodeGif(empty)).toThrow(MediaError);
  });
});

describe('compositeStep', () => {
  it('disposal 1 keeps the canvas: a partial frame updates only its rect', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 0), disposal: 1 },
      { left: 1, top: 1, width: 2, height: 2, indices: fill(2, 2, 1), disposal: 1 },
    ]);
    const [, second] = compositeAll(gif);
    expect(pixel(second, 4, 0, 0)).toEqual(opaque(RED));
    expect(pixel(second, 4, 1, 1)).toEqual(opaque(GREEN));
    expect(pixel(second, 4, 2, 2)).toEqual(opaque(GREEN));
    expect(pixel(second, 4, 3, 3)).toEqual(opaque(RED));
  });

  it('transparent pixels leave the canvas underneath unchanged', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 2) },
      { width: 4, height: 4, indices: [3, 1, 1, 3, ...fill(4, 3, 3)], transparentIndex: 3 },
    ]);
    const [, second] = compositeAll(gif);
    expect(pixel(second, 4, 0, 0)).toEqual(opaque(BLUE));
    expect(pixel(second, 4, 1, 0)).toEqual(opaque(GREEN));
    expect(pixel(second, 4, 3, 3)).toEqual(opaque(BLUE));
  });

  it('disposal 2 clears the frame rect to transparent (not the background colour)', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 0), disposal: 1 },
      { left: 0, top: 0, width: 2, height: 2, indices: fill(2, 2, 1), disposal: 2 },
      { left: 3, top: 3, width: 1, height: 1, indices: [2] },
    ]);
    const [, second, third] = compositeAll(gif);
    expect(pixel(second, 4, 0, 0)).toEqual(opaque(GREEN));
    expect(pixel(third, 4, 0, 0)).toEqual(CLEAR);
    expect(pixel(third, 4, 1, 1)).toEqual(CLEAR);
    expect(pixel(third, 4, 2, 2)).toEqual(opaque(RED));
    expect(pixel(third, 4, 3, 3)).toEqual(opaque(BLUE));
  });

  it('disposal 3 restores the canvas from before the frame', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 0), disposal: 1 },
      { left: 0, top: 0, width: 4, height: 2, indices: fill(4, 2, 2), disposal: 3 },
      { left: 3, top: 3, width: 1, height: 1, indices: [1] },
    ]);
    const [, second, third] = compositeAll(gif);
    expect(pixel(second, 4, 0, 0)).toEqual(opaque(BLUE));
    expect(pixel(third, 4, 0, 0)).toEqual(opaque(RED));
    expect(pixel(third, 4, 3, 1)).toEqual(opaque(RED));
    expect(pixel(third, 4, 3, 3)).toEqual(opaque(GREEN));
  });

  it('disposal 3 on the first frame restores to the empty canvas', () => {
    const gif = gifOf([
      { width: 4, height: 4, indices: fill(4, 4, 0), disposal: 3 },
      { left: 0, top: 0, width: 1, height: 1, indices: [1] },
    ]);
    const [first, second] = compositeAll(gif);
    expect(hasTransparentPixel(first)).toBe(false);
    expect(pixel(second, 4, 0, 0)).toEqual(opaque(GREEN));
    expect(pixel(second, 4, 1, 1)).toEqual(CLEAR);
  });

  it('clips frame rects that extend past the logical screen', () => {
    const gif = gifOf([{ left: 2, top: 3, width: 4, height: 3, indices: fill(4, 3, 1), disposal: 2 }, { width: 1, height: 1, indices: [0] }]);
    const [first, second] = compositeAll(gif);
    expect(pixel(first, 4, 2, 3)).toEqual(opaque(GREEN));
    expect(pixel(first, 4, 3, 3)).toEqual(opaque(GREEN));
    expect(pixel(first, 4, 1, 3)).toEqual(CLEAR);
    expect(pixel(second, 4, 3, 3)).toEqual(CLEAR);
  });

  it('treats palette indices past the colour table as transparent, like Chromium', () => {
    const gif = gifOf([
      { width: 2, height: 1, indices: [0, 0] },
      { width: 2, height: 1, indices: [9, 1], localPalette: [WHITE, BLUE] },
    ], { width: 2, height: 1 });
    const [, second] = compositeAll(gif);
    expect(pixel(second, 2, 0, 0)).toEqual(opaque(RED));
    expect(pixel(second, 2, 1, 0)).toEqual(opaque(BLUE));
  });
});

describe('GifCompositor', () => {
  const frames: TestFrame[] = Array.from({ length: 23 }, (_, i) => ({
    left: i % 3,
    top: (i * 2) % 3,
    width: 2,
    height: 2,
    indices: [i % 4, (i + 1) % 4, 3, (i + 2) % 4],
    transparentIndex: i % 5 === 0 ? 3 : undefined,
    disposal: [0, 1, 2, 3][i % 4],
  }));

  it('random access equals sequential compositing for any checkpoint interval and index budget', () => {
    const gif = gifOf(frames);
    const expected = compositeAll(gif);
    for (const [interval, indexBudget] of [[1, 1e6], [2, 1e6], [5, 8], [8, 1], [100, 30]]) {
      const compositor = new GifCompositor(gif, interval, indexBudget);
      const order = [22, 3, 3, 0, 17, 16, 18, 9, 21, 1, 22, 8, 7, 6, 12, 0];
      for (const i of order) {
        expect(Array.from(compositor.frameAt(i)), `frame ${i} @ interval ${interval}, budget ${indexBudget}`).toEqual(Array.from(expected[i]));
      }
    }
  });

  it('clamps out-of-range indices', () => {
    const gif = gifOf(frames);
    const compositor = new GifCompositor(gif, 4);
    const last = Array.from(compositeAll(gif)[22]);
    expect(Array.from(compositor.frameAt(99))).toEqual(last);
  });
});

describe('fixtures', () => {
  it('transparent_variable_duration.gif: 24 frames alternating 120 / 40 ms, transparent, loops forever', () => {
    const gif = decodeGif(readFileSync(join(FIXTURES, 'transparent_variable_duration.gif')));
    expect([gif.width, gif.height]).toEqual([320, 240]);
    expect(gif.frames).toHaveLength(24);
    expect(gif.frames.map((f) => f.delayMs)).toEqual(Array.from({ length: 24 }, (_, i) => (i % 2 ? 40 : 120)));
    expect(gif.loopCount).toBe(0);
    const composited = compositeAll(gif);
    expect(composited.every(hasTransparentPixel)).toBe(true);
    // Disposal 2 between frames: the previous frame's moving square must not leave a trail.
    const ball = (i: number) => {
      const a = (2 * Math.PI * i) / 24;
      return [Math.round(160 + 90 * Math.cos(a)), Math.round(120 + 70 * Math.sin(a))] as const;
    };
    const [x0, y0] = ball(0);
    expect(pixel(composited[0], 320, x0, y0)[3]).toBe(255);
    expect(pixel(composited[6], 320, x0, y0)[3]).toBe(0);
  });

  it('long_200_frames.gif: all 200 frames at 30 ms, nothing truncated', () => {
    const gif = decodeGif(readFileSync(join(FIXTURES, 'long_200_frames.gif')));
    expect(gif.frames).toHaveLength(200);
    expect(new Set(gif.frames.map((f) => f.delayMs))).toEqual(new Set([30]));
    const compositor = new GifCompositor(gif, 8);
    expect(hasTransparentPixel(compositor.frameAt(199))).toBe(false);
  });

  const corpusGif = (name: string) => join(CORPUS, 'gifs', name);

  it.skipIf(!existsSync(corpusGif('partial_updates_optimized.gif')))(
    'partial_updates_optimized.gif (corpus): every frame is a complete image',
    () => {
      const gif = decodeGif(readFileSync(corpusGif('partial_updates_optimized.gif')));
      expect(gif.frames).toHaveLength(16);
      const composited = compositeAll(gif);
      for (let i = 1; i < 16; i++) {
        const frame = composited[i];
        expect(hasTransparentPixel(frame), `frame ${i}`).toBe(false);
        // Each frame copies the previous one plus a new red square, so all squares so far are present...
        for (let k = 1; k <= i; k++) {
          const [r, g, b] = pixel(frame, gif.width, k * 20 + 20, k * 20 + 20);
          expect(r > 200 && g < 60 && b < 60, `square ${k} in frame ${i}`).toBe(true);
        }
        // ...and the untouched background matches frame 0.
        const [r0, g0, b0] = pixel(composited[0], gif.width, 350, 5);
        const [r, g, b] = pixel(frame, gif.width, 350, 5);
        expect(Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)).toBeLessThan(24);
      }
    },
  );

  it.skipIf(!existsSync(corpusGif('golden_gate_3s_480.gif')))(
    'golden_gate_3s_480.gif (corpus): transparent-delta frames composite to opaque full images',
    () => {
      const gif = decodeGif(readFileSync(corpusGif('golden_gate_3s_480.gif')));
      expect(gif.frames).toHaveLength(36);
      // The encoder stores only changed pixels; everything else uses the transparent index...
      const deltaFrames = gif.frames.slice(1).filter((f) => f.decodeIndices().some((i) => i === f.transparentIndex));
      expect(deltaFrames.length).toBeGreaterThan(30);
      // ...so a frame drawn on its own has holes, while the composited frame has none.
      const alone = new Uint8ClampedArray(gif.width * gif.height * 4);
      const frame = gif.frames[20];
      compositeStep(new Uint8ClampedArray(alone.length), alone, gif.width, gif.height, frame, frame.decodeIndices());
      expect(hasTransparentPixel(alone)).toBe(true);
      expect(compositeAll(gif).some(hasTransparentPixel)).toBe(false);
    },
  );
});
