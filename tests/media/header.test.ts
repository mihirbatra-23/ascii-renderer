import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffFormat } from '../../src/media/detect';
import { readImageHeader } from '../../src/media/header';

const read = (path: string) => new Uint8Array(readFileSync(path));
const FIXTURES = join(__dirname, '..', 'fixtures');
const LOCAL = join(__dirname, 'fixtures');

describe('readImageHeader', () => {
  it.each([
    [FIXTURES, 'torus_450.png', 450, 450, false],
    [FIXTURES, 'gray16_200.png', 200, 200, false],
    [FIXTURES, 'logo_rgba_256.png', 256, 256, true],
    // Stored size: EXIF orientation is applied by the decoder, not here.
    [FIXTURES, 'exif6_480x270.jpg', 480, 270, false],
    [FIXTURES, 'transparent_variable_duration.gif', 320, 240, true],
    [LOCAL, 'anim_3f.png', 64, 48, true],
    [LOCAL, 'anim_3f.webp', 64, 48, true],
    [LOCAL, 'still_lossy.webp', 64, 48, false],
    [LOCAL, 'still_alpha_lossless.webp', 64, 48, true],
    [LOCAL, 'still.avif', 64, 48, true],
    [LOCAL, 'anim_3f.avif', 64, 48, true],
    [LOCAL, 'still.bmp', 64, 48, false],
    [LOCAL, 'icon.ico', 48, 36, true],
    [LOCAL, 'still.heic', 64, 48, true],
  ])('%s/%s → %i×%i alpha:%s', (dir, file, width, height, mayHaveAlpha) => {
    const bytes = read(join(dir, file));
    expect(readImageHeader(bytes, sniffFormat(bytes).format)).toEqual({ width, height, mayHaveAlpha });
  });

  it('finds the JPEG frame header after large APP segments', () => {
    const jpeg = read(join(FIXTURES, 'exif6_480x270.jpg'));
    const app = new Uint8Array(4 + 60_000);
    app.set([0xff, 0xe2, (60_002 >> 8) & 0xff, 60_002 & 0xff]);
    const padded = new Uint8Array(jpeg.length + app.length);
    padded.set(jpeg.subarray(0, 2));
    padded.set(app, 2);
    padded.set(jpeg.subarray(2), 2 + app.length);
    expect(readImageHeader(padded, 'JPEG')).toMatchObject({ width: 480, height: 270 });
  });

  it('flags PNGs with a tRNS chunk as possibly transparent', () => {
    // Palette PNG: IHDR (colour type 3), then tRNS before IDAT.
    const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', [0, 0, 0, 7, 0, 0, 0, 5, 8, 3, 0, 0, 0]),
      ...chunk('PLTE', [0, 0, 0]),
      ...chunk('tRNS', [0]),
      ...chunk('IDAT', []),
    ]);
    expect(readImageHeader(png, 'PNG')).toEqual({ width: 7, height: 5, mayHaveAlpha: true });
  });

  it('returns null for truncated or unparsed input', () => {
    expect(readImageHeader(new Uint8Array(10), 'PNG')).toBeNull();
    expect(readImageHeader(read(join(LOCAL, 'badge.svg')), 'SVG')).toBeNull();
    expect(readImageHeader(read(join(FIXTURES, 'exif6_480x270.jpg')).subarray(0, 30), 'JPEG')).toBeNull();
  });
});
