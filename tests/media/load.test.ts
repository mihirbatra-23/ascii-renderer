/** loadMedia routing and limit checks that run before any browser decoding (so they work in Node). */
import { describe, expect, it } from 'vitest';
import { loadMedia } from '../../src/media/load';
import { MediaError, type MediaErrorCode } from '../../src/media/types';
import { writeGif } from './helpers/gif-writer';

async function errorOf(blob: Blob): Promise<{ code: MediaErrorCode; message: string }> {
  try {
    await loadMedia(blob, 'test');
  } catch (error) {
    if (error instanceof MediaError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected loadMedia to reject');
}

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

describe('loadMedia', () => {
  it('rejects empty files', async () => {
    expect((await errorOf(new Blob([]))).code).toBe('empty-file');
  });

  it('rejects files that are not media, by content rather than name or type', async () => {
    const error = await errorOf(new File(['not really a png'], 'photo.png', { type: 'image/png' }));
    expect(error.code).toBe('unsupported-format');
    expect(error.message).toMatch(/isn't supported/);
  });

  it('rejects oversized images from the header, before decoding', async () => {
    const error = await errorOf(new Blob([pngHeader(20_000, 20_000)]));
    expect(error).toEqual({
      code: 'too-large',
      message: 'This image is 20000 × 20000 (400 megapixels); the limit is 100 megapixels. Resize it and try again.',
    });
  });

  it('rejects animations with too many frames instead of truncating them', async () => {
    const frame = { width: 1, height: 1, indices: [0] };
    const gif = writeGif({ width: 1, height: 1, globalPalette: [[0, 0, 0], [255, 255, 255]], loop: 0, frames: new Array(2001).fill(frame) });
    const error = await errorOf(new Blob([gif]));
    expect(error.code).toBe('too-large');
    expect(error.message).toMatch(/2,001 frames/);
  });

  // a damaged GIF whose header claims a huge screen used to be reported as "too large".
  it('reports a GIF with no image blocks as damaged, not too large, and offers no retry', async () => {
    const header = new Uint8Array(13 + 256 * 3 + 64);
    header.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    new DataView(header.buffer).setUint16(6, 52944, true);
    new DataView(header.buffer).setUint16(8, 36208, true);
    header[10] = 0xf7; // global colour table of 256 entries
    header.fill(0x5a, 13 + 256 * 3); // garbage where the first block should be
    let caught: unknown;
    try {
      await loadMedia(new Blob([header]), 'garbage.gif');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MediaError);
    const error = caught as MediaError;
    expect(error.code).toBe('decode-failed');
    expect(error.message).toMatch(/no readable frames/);
    expect(error.transient).toBe(false);
  });
});
