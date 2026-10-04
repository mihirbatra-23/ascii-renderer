/**
 * Format detection by magic bytes only (never MIME type or extension, which are routinely wrong
 * for pasted, renamed or downloaded files).
 */
import { ascii, indexOfAscii, startsWith, u16le, u32be, u32le, u8 } from './bytes';

export type SniffKind = 'image' | 'animation' | 'video' | 'unknown';

export interface SniffResult {
  kind: SniffKind;
  /** Short format label: 'JPEG', 'PNG', 'APNG', 'GIF', 'WebP', 'AVIF', 'HEIC', 'HEIF', 'BMP', 'ICO', 'SVG',
   *  'MP4', 'MOV', 'M4V', '3GP', 'WebM', 'MKV', 'Ogg', or 'unknown'. */
  format: string;
}

/**
 * Bytes of the file head that are enough to classify every format except GIF animation, which
 * needs the whole file to find a second frame after a large first one.
 */
export const SNIFF_HEAD_BYTES = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'miaf']);
const AUDIO_ONLY_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
/** Top-level atoms that open QuickTime files written without an ftyp box. */
const QT_LEGACY_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

const result = (kind: SniffKind, format: string): SniffResult => ({ kind, format });
const UNKNOWN = result('unknown', 'unknown');

export function sniffFormat(bytes: Uint8Array): SniffResult {
  if (bytes.length < 4) return UNKNOWN;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return result('image', 'JPEG');
  if (startsWith(bytes, PNG_SIGNATURE)) return sniffPng(bytes);
  const magic6 = ascii(bytes, 0, 6);
  if (magic6 === 'GIF87a' || magic6 === 'GIF89a') {
    return result(countGifFrames(bytes, 2) > 1 ? 'animation' : 'image', 'GIF');
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return sniffWebp(bytes);
  if (ascii(bytes, 4, 4) === 'ftyp') return sniffFtyp(bytes);
  if (startsWith(bytes, EBML_MAGIC)) return result('video', matroskaDocType(bytes) === 'webm' ? 'WebM' : 'MKV');
  if (ascii(bytes, 0, 4) === 'OggS') return result('video', 'Ogg');
  if (ascii(bytes, 0, 2) === 'BM' && BMP_DIB_SIZES.has(u32le(bytes, 14))) return result('image', 'BMP');
  if (isIco(bytes)) return result('image', 'ICO');
  if (QT_LEGACY_ATOMS.has(ascii(bytes, 4, 4)) && u32be(bytes, 0) >= 8) return result('video', 'MOV');
  if (looksLikeSvg(bytes)) return result('image', 'SVG');
  return UNKNOWN;
}

/** APNG is a PNG whose acTL chunk (which must precede IDAT) declares more than one frame. */
function sniffPng(b: Uint8Array): SniffResult {
  let at = 8;
  while (at + 8 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    if (type === 'acTL') return result(u32be(b, at + 8) > 1 ? 'animation' : 'image', 'APNG');
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + length;
  }
  return result('image', 'PNG');
}

function sniffWebp(b: Uint8Array): SniffResult {
  // VP8X (extended) carries feature flags; bit 1 = animation. Plain VP8 / VP8L are always stills.
  const animated = ascii(b, 12, 4) === 'VP8X' && (u8(b, 20) & 0x02) !== 0;
  return result(animated ? 'animation' : 'image', 'WebP');
}

function sniffFtyp(b: Uint8Array): SniffResult {
  const boxSize = u32be(b, 0);
  const major = ascii(b, 8, 4);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= Math.min(boxSize, b.length); at += 4) compatible.push(ascii(b, at, 4));

  if (AUDIO_ONLY_BRANDS.has(major)) return UNKNOWN;
  const byMajor = classifyBrand(major);
  if (byMajor) return byMajor;
  // Generic majors (e.g. 'mif1', or unknown vendor brands): look for a specific compatible brand.
  for (const brand of compatible) {
    const byBrand = classifyBrand(brand);
    if (byBrand) return byBrand;
  }
  return HEIF_BRANDS.has(major) ? result('image', 'HEIF') : UNKNOWN;
}

function classifyBrand(brand: string): SniffResult | null {
  if (brand === 'avis') return result('animation', 'AVIF');
  if (brand === 'avif') return result('image', 'AVIF');
  if (HEIC_BRANDS.has(brand)) return result('image', 'HEIC');
  if (brand === 'qt  ') return result('video', 'MOV');
  if (brand.startsWith('M4V')) return result('video', 'M4V');
  if (brand.startsWith('3gp') || brand.startsWith('3g2')) return result('video', '3GP');
  if (/^(isom|iso[2-9]|mp41|mp42|mp71|avc1|hvc1|av01|dash|mmp4|f4v |MSNV|NDAS|XAVC|cmf[c2]|MP4 )$/.test(brand)) {
    return result('video', 'MP4');
  }
  return null;
}

/** Reads the EBML DocType ('webm' or 'matroska') from the header element. */
function matroskaDocType(b: Uint8Array): string {
  const at = indexOfAscii(b, '\x42\x82', 4, 64);
  if (at < 0) return '';
  const sizeByte = u8(b, at + 2);
  // EBML sizes are VINTs; DocType is short, so the 1-byte form (0x80 | n) is the norm.
  if ((sizeByte & 0x80) === 0) return '';
  return ascii(b, at + 3, sizeByte & 0x7f);
}

function isIco(b: Uint8Array): boolean {
  const type = u16le(b, 2);
  const count = u16le(b, 4);
  return u16le(b, 0) === 0 && (type === 1 || type === 2) && count > 0 && count < 256 && u8(b, 9) === 0;
}

function looksLikeSvg(b: Uint8Array): boolean {
  let at = startsWith(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (at < b.length && (b[at] === 0x20 || b[at] === 0x09 || b[at] === 0x0a || b[at] === 0x0d)) at++;
  if (u8(b, at) !== 0x3c /* '<' */) return false;
  const text = ascii(b, at, Math.min(4096, b.length - at)).toLowerCase();
  const svgAt = text.indexOf('<svg');
  if (svgAt < 0) return false;
  const htmlAt = text.indexOf('<html');
  return htmlAt < 0 || htmlAt > svgAt;
}

/** Shown for a GIF whose blocks hold no image (a damaged or cut-off file). */
export const GIF_NO_FRAMES = 'The GIF has no readable frames. It may be damaged or incomplete.';

/**
 * Counts image descriptors by walking GIF blocks (no LZW decoding). Stops early at `stopAt`.
 * A truncated buffer yields the frames seen so far.
 */
export function countGifFrames(b: Uint8Array, stopAt = Number.POSITIVE_INFINITY): number {
  const packed = u8(b, 10);
  let at = 13 + ((packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  let frames = 0;
  while (at < b.length && frames < stopAt) {
    const block = b[at];
    if (block === 0x2c) {
      frames++;
      const local = u8(b, at + 9);
      at += 10 + ((local & 0x80) !== 0 ? 3 * (1 << ((local & 0x07) + 1)) : 0);
      at = skipSubBlocks(b, at + 1); // +1: LZW minimum code size
    } else if (block === 0x21) {
      at = skipSubBlocks(b, at + 2);
    } else {
      break; // 0x3b trailer or garbage
    }
  }
  return frames;
}

function skipSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length) {
    const size = b[at++];
    if (size === 0) break;
    at += size;
  }
  return at;
}
