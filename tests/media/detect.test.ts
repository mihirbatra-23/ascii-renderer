import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countGifFrames, sniffFormat } from '../../src/media/detect';
import { writeGif } from './helpers/gif-writer';

const FIXTURES = join(__dirname, '..', 'fixtures');
const LOCAL = join(__dirname, 'fixtures');
const read = (dir: string, name: string) => new Uint8Array(readFileSync(join(dir, name)));

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ftyp = (major: string, ...compatible: string[]) =>
  bytes(be32(16 + 4 * compatible.length), 'ftyp', major, [0, 0, 0, 0], ...compatible, be32(8), 'mdat');

describe('sniffFormat: committed fixtures', () => {
  it.each([
    ['torus_450.png', 'image', 'PNG'],
    ['gray16_200.png', 'image', 'PNG'],
    ['logo_rgba_256.png', 'image', 'PNG'],
    ['exif6_480x270.jpg', 'image', 'JPEG'],
    ['transparent_variable_duration.gif', 'animation', 'GIF'],
    ['long_200_frames.gif', 'animation', 'GIF'],
    ['testsrc2_4s.mp4', 'video', 'MP4'],
  ])('%s → %s %s', (file, kind, format) => {
    expect(sniffFormat(read(FIXTURES, file))).toEqual({ kind, format });
  });

  it.each([
    ['anim_3f.png', 'animation', 'APNG'],
    ['anim_3f.webp', 'animation', 'WebP'],
    ['anim_3f.avif', 'animation', 'AVIF'],
    ['still_lossy.webp', 'image', 'WebP'],
    ['still_alpha_lossless.webp', 'image', 'WebP'],
    ['still.avif', 'image', 'AVIF'],
    ['still.bmp', 'image', 'BMP'],
    ['icon.ico', 'image', 'ICO'],
    ['badge.svg', 'image', 'SVG'],
    ['still.heic', 'image', 'HEIC'],
  ])('%s → %s %s', (file, kind, format) => {
    expect(sniffFormat(read(LOCAL, file))).toEqual({ kind, format });
  });

  it('classifies from the 64 KB head for everything but GIF frame counts', () => {
    expect(sniffFormat(read(FIXTURES, 'testsrc2_4s.mp4').subarray(0, 64 * 1024)).kind).toBe('video');
  });
});

describe('sniffFormat: synthetic headers', () => {
  it.each([
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'image', 'JPEG'],
    ['PNG, IDAT before any acTL', bytes([0x89], 'PNG', [13, 10, 26, 10], be32(0), 'IDAT', be32(0)), 'image', 'PNG'],
    ['APNG with a 1-frame acTL', bytes([0x89], 'PNG', [13, 10, 26, 10], be32(8), 'acTL', be32(1), be32(0), be32(0)), 'image', 'APNG'],
    ['WebP VP8X without ANIM flag', bytes('RIFF', be32(0), 'WEBP', 'VP8X', [10, 0, 0, 0, 0x10]), 'image', 'WebP'],
    ['WebP VP8X with ANIM flag', bytes('RIFF', be32(0), 'WEBP', 'VP8X', [10, 0, 0, 0, 0x12]), 'animation', 'WebP'],
    ['AVIF still', ftyp('avif', 'mif1', 'miaf'), 'image', 'AVIF'],
    ['AVIF sequence', ftyp('avis', 'avif', 'msf1'), 'animation', 'AVIF'],
    ['HEIC', ftyp('heic', 'mif1', 'heic'), 'image', 'HEIC'],
    ['HEIF generic major with heic brand', ftyp('mif1', 'mif1', 'heic'), 'image', 'HEIC'],
    ['HEIF generic only', ftyp('mif1', 'mif1'), 'image', 'HEIF'],
    ['MP4 isom', ftyp('isom', 'iso2', 'avc1', 'mp41'), 'video', 'MP4'],
    ['MP4 mp42', ftyp('mp42', 'isom'), 'video', 'MP4'],
    ['QuickTime', ftyp('qt  ', 'qt  '), 'video', 'MOV'],
    ['M4V', ftyp('M4V ', 'M4V ', 'mp42', 'isom'), 'video', 'M4V'],
    ['3GP', ftyp('3gp4', 'isom'), 'video', '3GP'],
    ['unknown major with video compatible brand', ftyp('XYZW', 'mp42'), 'video', 'MP4'],
    ['legacy QuickTime without ftyp', bytes(be32(1000), 'moov', be32(108), 'mvhd'), 'video', 'MOV'],
    ['WebM', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84], 'webm'), 'video', 'WebM'],
    ['Matroska', bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], 'matroska'), 'video', 'MKV'],
    ['Ogg', bytes('OggS', [0, 2, 0, 0]), 'video', 'Ogg'],
    ['BMP (BITMAPINFOHEADER)', bytes('BM', be32(0), be32(0), [54, 0, 0, 0, 40, 0, 0, 0]), 'image', 'BMP'],
    ['ICO', bytes([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]), 'image', 'ICO'],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image', 'SVG'],
    ['SVG with BOM, whitespace, prolog, comment, doctype', bytes([0xef, 0xbb, 0xbf], '\n  <?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg/>'), 'image', 'SVG'],
  ] as const)('%s', (_label, input, kind, format) => {
    expect(sniffFormat(input)).toEqual({ kind, format });
  });

  it.each([
    ['empty', bytes()],
    ['3 bytes', bytes([0xff, 0xd8, 0xff]).subarray(0, 3)],
    ['plain text', bytes('hello world, this is not media')],
    ['HTML with inline SVG', bytes('<!doctype html><html><body><svg></svg></body></html>')],
    ['XML that is not SVG', bytes('<?xml version="1.0"?><feed></feed>')],
    ['audio-only M4A', ftyp('M4A ', 'M4A ', 'mp42', 'isom')],
    ['unrelated ISO-BMFF brand', ftyp('crx ', 'crx ')],
    ['"BM" text', bytes('BMW is a car brand, not a bitmap')],
    ['PDF', bytes('%PDF-1.7\n')],
    ['ZIP', bytes([0x50, 0x4b, 0x03, 0x04, 0, 0])],
  ])('%s → unknown', (_label, input) => {
    expect(sniffFormat(input)).toEqual({ kind: 'unknown', format: 'unknown' });
  });

  it('GIF with one frame is an image, two or more an animation', () => {
    const frame = { width: 1, height: 1, indices: [0] };
    const palette: [number, number, number][] = [[0, 0, 0], [255, 255, 255]];
    expect(sniffFormat(writeGif({ width: 1, height: 1, globalPalette: palette, frames: [frame] }))).toEqual({ kind: 'image', format: 'GIF' });
    expect(sniffFormat(writeGif({ width: 1, height: 1, globalPalette: palette, loop: 0, frames: [frame, frame] }))).toEqual({ kind: 'animation', format: 'GIF' });
  });
});

describe('countGifFrames', () => {
  it('counts every frame of the fixtures without decoding', () => {
    expect(countGifFrames(read(FIXTURES, 'transparent_variable_duration.gif'))).toBe(24);
    expect(countGifFrames(read(FIXTURES, 'long_200_frames.gif'))).toBe(200);
  });

  it('stops early and tolerates truncation', () => {
    const gif = read(FIXTURES, 'long_200_frames.gif');
    expect(countGifFrames(gif, 2)).toBe(2);
    const partial = countGifFrames(gif.subarray(0, gif.length >> 1));
    expect(partial).toBeGreaterThan(50);
    expect(partial).toBeLessThan(200);
  });
});
