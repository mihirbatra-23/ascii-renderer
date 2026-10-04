/**
 * Minimal GIF89a writer for tests: every GIF feature the compositor must honour (frame offsets,
 * disposal, transparency, local palettes, interlacing, NETSCAPE loops) can be produced exactly.
 * LZW output is "uncompressed" (a clear code every 254 literals at 8-bit min code size), which
 * every decoder accepts.
 */

export type Rgb = [number, number, number];

export interface TestFrame {
  left?: number;
  top?: number;
  width: number;
  height: number;
  /** Row-major palette indices (in display order; the writer interlaces if asked). */
  indices: ArrayLike<number>;
  localPalette?: Rgb[];
  transparentIndex?: number;
  disposal?: number;
  /** Delay in centiseconds. */
  delayCs?: number;
  interlaced?: boolean;
  /** Omit the graphic control extension entirely. */
  noGce?: boolean;
}

export interface TestGif {
  width: number;
  height: number;
  globalPalette?: Rgb[];
  /** NETSCAPE loop count; undefined = no extension. */
  loop?: number;
  frames: TestFrame[];
}

export function writeGif(gif: TestGif): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
  const ascii = (s: string) => {
    for (const c of s) out.push(c.charCodeAt(0));
  };

  ascii('GIF89a');
  u16(gif.width);
  u16(gif.height);
  if (gif.globalPalette) {
    const table = paddedPalette(gif.globalPalette);
    out.push(0x80 | 0x70 | table.sizeBits, 0, 0);
    out.push(...table.bytes);
  } else {
    out.push(0x70, 0, 0);
  }

  if (gif.loop !== undefined) {
    out.push(0x21, 0xff, 11);
    ascii('NETSCAPE2.0');
    out.push(3, 1, gif.loop & 0xff, (gif.loop >> 8) & 0xff, 0);
  }

  for (const f of gif.frames) {
    if (!f.noGce) {
      const transparent = f.transparentIndex !== undefined;
      out.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (transparent ? 1 : 0));
      u16(f.delayCs ?? 0);
      out.push(transparent ? f.transparentIndex! : 0, 0);
    }
    out.push(0x2c);
    u16(f.left ?? 0);
    u16(f.top ?? 0);
    u16(f.width);
    u16(f.height);
    const local = f.localPalette ? paddedPalette(f.localPalette) : null;
    out.push((local ? 0x80 | local.sizeBits : 0) | (f.interlaced ? 0x40 : 0));
    if (local) out.push(...local.bytes);
    const rows = f.interlaced ? interlaceRows(f.indices, f.width, f.height) : Array.from(f.indices);
    out.push(8);
    for (const block of subBlocks(lzwUncompressed(rows))) out.push(...block);
    out.push(0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

function paddedPalette(colors: Rgb[]): { bytes: number[]; sizeBits: number } {
  let sizeBits = 0;
  while (2 << sizeBits < colors.length) sizeBits++;
  const bytes: number[] = [];
  for (let i = 0; i < 2 << sizeBits; i++) bytes.push(...(colors[i] ?? [0, 0, 0]));
  return { bytes, sizeBits };
}

function interlaceRows(indices: ArrayLike<number>, width: number, height: number): number[] {
  const order: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) order.push(y);
  }
  return order.flatMap((y) => Array.from({ length: width }, (_, x) => indices[y * width + x]));
}

/** 9-bit codes, LSB first; a clear code before every 254 literals keeps the code size fixed. */
function lzwUncompressed(pixels: number[]): number[] {
  const clear = 256;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += 9;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  };
  pixels.forEach((p, i) => {
    if (i % 254 === 0) emit(clear);
    emit(p);
  });
  emit(clear + 1);
  if (bits > 0) bytes.push(acc & 0xff);
  return bytes;
}

function subBlocks(data: number[]): number[][] {
  const blocks: number[][] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    blocks.push([chunk.length, ...chunk]);
  }
  return blocks;
}
