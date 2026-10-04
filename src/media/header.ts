/**
 * Image dimensions and an alpha hint read from file headers, so oversized images are rejected
 * before a full decode and opaque formats skip the pixel alpha scan.
 */
import { ascii, i32le, indexOfAscii, u16be, u16le, u24le, u32be, u32le, u8 } from './bytes';

export interface HeaderInfo {
  /** Stored (pre-orientation) size. */
  width: number;
  height: number;
  /** False only when the header proves the image is opaque. */
  mayHaveAlpha: boolean;
}

/** Returns null when the format is not parsed here or the size is not within `bytes`. */
export function readImageHeader(bytes: Uint8Array, format: string): HeaderInfo | null {
  switch (format) {
    case 'PNG':
    case 'APNG':
      return pngHeader(bytes);
    case 'JPEG':
      return jpegHeader(bytes);
    case 'GIF':
      return sized(u16le(bytes, 6), u16le(bytes, 8), true);
    case 'WebP':
      return webpHeader(bytes);
    case 'BMP':
      return bmpHeader(bytes);
    case 'ICO':
      return icoHeader(bytes);
    case 'AVIF':
    case 'HEIC':
    case 'HEIF':
      return heifHeader(bytes);
    default:
      return null;
  }
}

function sized(width: number, height: number, mayHaveAlpha: boolean): HeaderInfo | null {
  return width > 0 && height > 0 ? { width, height, mayHaveAlpha } : null;
}

function pngHeader(b: Uint8Array): HeaderInfo | null {
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  const colorType = u8(b, 25);
  // Colour types 4 (grey+alpha) and 6 (RGBA) carry alpha; others only via a tRNS chunk before IDAT.
  let mayHaveAlpha = colorType === 4 || colorType === 6;
  for (let at = 8; !mayHaveAlpha && at + 8 <= b.length; at += 12 + u32be(b, at)) {
    const type = ascii(b, at + 4, 4);
    if (type === 'tRNS') mayHaveAlpha = true;
    if (type === 'IDAT') break;
  }
  return sized(u32be(b, 16), u32be(b, 20), mayHaveAlpha);
}

function jpegHeader(b: Uint8Array): HeaderInfo | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized(u16be(b, at + 7), u16be(b, at + 5), false);
    }
    const standalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
    at += standalone ? 2 : 2 + u16be(b, at + 2);
  }
  return null;
}

function webpHeader(b: Uint8Array): HeaderInfo | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    // Animated files often omit the alpha flag even when frames carry alpha, so it only counts for stills.
    const flags = u8(b, 20);
    return sized(u24le(b, 24) + 1, u24le(b, 27) + 1, (flags & 0x12) !== 0);
  }
  if (chunk === 'VP8L' && u8(b, 20) === 0x2f) {
    const bits = u32le(b, 21);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, ((bits >>> 28) & 1) !== 0);
  }
  if (chunk === 'VP8 ') return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, false);
  return null;
}

function bmpHeader(b: Uint8Array): HeaderInfo | null {
  const dibSize = u32le(b, 14);
  if (dibSize === 12) return sized(u16le(b, 18), u16le(b, 20), false);
  const bitsPerPixel = u16le(b, 28);
  // Rows are stored bottom-up unless the height is negative.
  return sized(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)), bitsPerPixel === 32);
}

function icoHeader(b: Uint8Array): HeaderInfo | null {
  let best: HeaderInfo | null = null;
  const count = u16le(b, 4);
  for (let i = 0; i < count && 6 + 16 * (i + 1) <= b.length; i++) {
    const entry = 6 + 16 * i;
    const width = u8(b, entry) || 256;
    const height = u8(b, entry + 1) || 256;
    if (!best || width * height > best.width * best.height) best = { width, height, mayHaveAlpha: true };
  }
  return best;
}

/** AVIF / HEIC: the largest 'ispe' (image spatial extents) property, which covers grid images. */
function heifHeader(b: Uint8Array): HeaderInfo | null {
  let best: HeaderInfo | null = null;
  for (let at = indexOfAscii(b, 'ispe'); at >= 0; at = indexOfAscii(b, 'ispe', at + 4)) {
    const width = u32be(b, at + 8);
    const height = u32be(b, at + 12);
    if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
      best = { width, height, mayHaveAlpha: true };
    }
  }
  return best;
}
