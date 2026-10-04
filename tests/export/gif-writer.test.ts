import { decompressFrames, parseGIF } from 'gifuct-js';
import { describe, expect, it } from 'vitest';
import { FrameDiffer } from '../../src/export/gif-delta';
import type { Palette } from '../../src/export/gif-palette';
import { colorTableBits, GifWriter } from '../../src/export/gif-writer';

/** A deterministic pseudo-random generator, so failures reproduce. */
function rng(seed: number) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function grey(n: number): Palette {
  return Array.from({ length: n }, (_, i) => [i, i, i]);
}

function decode(bytes: Uint8Array) {
  const parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return { parsed, frames: decompressFrames(parsed, false) };
}

/** Composites decoded frames over a canvas of palette indices, as a viewer would (disposal 1). */
function composite(width: number, height: number, frames: ReturnType<typeof decode>['frames']): Uint8Array[] {
  const canvas = new Uint8Array(width * height);
  return frames.map((f) => {
    const { left, top, width: w, height: h } = f.dims;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = f.pixels[y * w + x];
        if (f.transparentIndex !== undefined && v === f.transparentIndex) continue;
        canvas[(top + y) * width + left + x] = v;
      }
    }
    return canvas.slice();
  });
}

describe('colorTableBits', () => {
  it('is the smallest power of two that holds the colours (GIF minimum 2 entries)', () => {
    expect([1, 2, 3, 4, 5, 16, 17, 32, 33, 255, 256].map(colorTableBits)).toEqual([1, 1, 2, 2, 3, 4, 5, 5, 6, 8, 8]);
  });
});

describe('GifWriter', () => {
  it('writes a file a decoder reads back exactly: size, palette, delays, loop and pixels', () => {
    const width = 37;
    const height = 23;
    const random = rng(1);
    const frames = [0, 1, 2].map(() => Uint8Array.from({ length: width * height }, () => Math.floor(random() * 12)));
    const writer = new GifWriter(width, height, grey(12), 3);
    frames.forEach((f, i) => writer.writeFrame(f, { x: 0, y: 0, width, height }, { delayCs: [4, 12, 7][i], disposal: 1 }));
    const bytes = writer.finish();
    const { parsed, frames: decoded } = decode(bytes);
    expect(parsed.lsd).toMatchObject({ width, height });
    expect(parsed.gct.slice(0, 12).map((c: ArrayLike<number>) => Array.from(c))).toEqual(grey(12));
    expect(decoded.map((f) => f.delay)).toEqual([40, 120, 70]);
    decoded.forEach((f, i) => expect(Uint8Array.from(f.pixels)).toEqual(frames[i]));
    // NETSCAPE2.0 repeat count 3.
    const at = Buffer.from(bytes).indexOf('NETSCAPE2.0');
    expect(bytes[at + 13] | (bytes[at + 14] << 8)).toBe(3);
    expect(bytes.at(-1)).toBe(0x3b);
  });

  it('omits the loop extension for a single play', () => {
    const writer = new GifWriter(2, 2, grey(2), -1);
    writer.writeFrame(new Uint8Array(4), { x: 0, y: 0, width: 2, height: 2 }, { delayCs: 10, disposal: 1 });
    expect(Buffer.from(writer.finish()).indexOf('NETSCAPE2.0')).toBe(-1);
  });

  it('LZW survives code-width changes and table resets on large, noisy and flat frames', () => {
    const width = 300;
    const height = 200;
    const random = rng(7);
    const cases: Array<[string, number, Uint8Array]> = [
      ['noise, 256 colours', 256, Uint8Array.from({ length: width * height }, () => Math.floor(random() * 256))],
      ['noise, 4 colours', 4, Uint8Array.from({ length: width * height }, () => Math.floor(random() * 4))],
      ['flat', 2, new Uint8Array(width * height)],
      ['stripes', 32, Uint8Array.from({ length: width * height }, (_, i) => (i >> 3) % 32)],
    ];
    for (const [name, colors, pixels] of cases) {
      const writer = new GifWriter(width, height, grey(colors), 0);
      writer.writeFrame(pixels, { x: 0, y: 0, width, height }, { delayCs: 4, disposal: 1 });
      const [frame] = decode(writer.finish()).frames;
      expect(Uint8Array.from(frame.pixels), name).toEqual(pixels);
    }
  });

  it('places sub-rectangle frames with their transparent index and disposal', () => {
    const writer = new GifWriter(10, 8, grey(5), 0);
    writer.writeFrame(new Uint8Array(80).fill(1), { x: 0, y: 0, width: 10, height: 8 }, { delayCs: 5, disposal: 1 });
    writer.writeFrame(Uint8Array.of(2, 4, 4, 3), { x: 6, y: 3, width: 2, height: 2 }, { delayCs: 5, disposal: 1, transparentIndex: 4 });
    const { frames } = decode(writer.finish());
    expect(frames[1].dims).toEqual({ left: 6, top: 3, width: 2, height: 2 });
    expect(frames[1].transparentIndex).toBe(4);
    expect(frames[1].disposalType).toBe(1);
    const [, second] = composite(10, 8, frames);
    expect(second[3 * 10 + 6]).toBe(2);
    expect(second[3 * 10 + 7]).toBe(1); // transparent: the first frame shows through
    expect(second[4 * 10 + 7]).toBe(3);
  });

  it('rejects rectangles outside the canvas', () => {
    const writer = new GifWriter(4, 4, grey(2), 0);
    expect(() => writer.writeFrame(new Uint8Array(4), { x: 3, y: 0, width: 2, height: 2 }, { delayCs: 1, disposal: 1 })).toThrow(RangeError);
  });
});

describe('FrameDiffer + GifWriter', () => {
  const width = 64;
  const height = 40;
  const T = 15;

  /** A moving 6×4 block over a static gradient: most pixels never change. */
  function clip(n: number): Uint8Array[] {
    return Array.from({ length: n }, (_, k) => {
      const f = Uint8Array.from({ length: width * height }, (_, i) => (i % width) % 8);
      for (let y = 10; y < 14; y++) for (let x = 3 * k; x < 3 * k + 6; x++) f[y * width + (x % width)] = 9 + (k % 4);
      return f;
    });
  }

  it('stores only the changed rectangle, and the composited frames equal the originals', () => {
    const frames = clip(12);
    frames.splice(6, 0, frames[5].slice()); // an identical frame keeps its slot (and delay)
    const differ = new FrameDiffer(width, height, T);
    const writer = new GifWriter(width, height, grey(T + 1), 0);
    const rects = frames.map((f) => {
      const d = differ.next(f);
      writer.writeFrame(d.indices, d.rect, { delayCs: 4, disposal: 1, transparentIndex: d.transparent ? T : undefined });
      return d.rect;
    });
    expect(rects[0]).toEqual({ x: 0, y: 0, width, height });
    expect(rects[1]).toEqual({ x: 0, y: 10, width: 9, height: 4 });
    expect(rects[6]).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    const { frames: decoded } = decode(writer.finish());
    expect(decoded).toHaveLength(frames.length);
    expect(composite(width, height, decoded)).toEqual(frames);
  });

  it('is much smaller than full frames for mostly static content', () => {
    const frames = clip(30);
    const full = new GifWriter(width, height, grey(T + 1), 0);
    const delta = new GifWriter(width, height, grey(T + 1), 0);
    const differ = new FrameDiffer(width, height, T);
    for (const f of frames) {
      full.writeFrame(f, { x: 0, y: 0, width, height }, { delayCs: 4, disposal: 1 });
      const d = differ.next(f);
      delta.writeFrame(d.indices, d.rect, { delayCs: 4, disposal: 1, transparentIndex: d.transparent ? T : undefined });
    }
    expect(delta.finish().byteLength).toBeLessThan(full.finish().byteLength / 4);
  });
});
