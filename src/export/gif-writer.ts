/**
 * GIF89a writer: one global colour table, NETSCAPE looping, and frames that cover any sub-rectangle
 * of the canvas with an optional transparent index, so animated exports can store only what changed
 * since the previous frame (see gif-delta.ts). Pure, so it runs in the GIF worker and unit tests.
 */
import type { Palette } from './gif-palette';

export interface GifRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GifFrameOptions {
  /** Display time in centiseconds. */
  delayCs: number;
  /** Palette index that leaves the pixel below unchanged. */
  transparentIndex?: number;
  /**
   * GIF disposal method: 1 keeps the frame for the next one to draw over (what delta frames need),
   * 2 clears it to the background.
   */
  disposal: number;
}

/** Growable byte buffer. */
class ByteStream {
  private bytes = new Uint8Array(1 << 16);
  private length = 0;

  byte(value: number): void {
    if (this.length === this.bytes.length) this.grow(this.length + 1);
    this.bytes[this.length++] = value;
  }

  u16(value: number): void {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }

  write(chunk: Uint8Array, length = chunk.length): void {
    if (this.length + length > this.bytes.length) this.grow(this.length + length);
    this.bytes.set(chunk.subarray(0, length), this.length);
    this.length += length;
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length);
  }

  private grow(min: number): void {
    const next = new Uint8Array(Math.max(min, this.bytes.length * 2));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
}

/** Bits per entry of the smallest power-of-two colour table holding `colors` entries (GIF minimum: 1). */
export function colorTableBits(colors: number): number {
  let bits = 1;
  while (1 << bits < colors) bits++;
  return bits;
}

export class GifWriter {
  private readonly out = new ByteStream();
  private readonly lzw: LzwEncoder;
  private readonly tableBits: number;

  /**
   * @param palette  The global colour table (≤ 256 entries; padded to a power of two with black).
   * @param repeat   NETSCAPE repeat count: -1 = play once (no extension), 0 = forever, n = n + 1 plays.
   */
  constructor(
    readonly width: number,
    readonly height: number,
    palette: Palette,
    repeat: number,
  ) {
    if (palette.length < 1 || palette.length > 256) throw new RangeError(`A GIF palette holds 1–256 colours (got ${palette.length}).`);
    this.tableBits = colorTableBits(palette.length);
    this.lzw = new LzwEncoder(Math.max(2, this.tableBits));
    const out = this.out;
    out.ascii('GIF89a');
    out.u16(width);
    out.u16(height);
    // Global colour table present, 8-bit colour resolution, unsorted, table size.
    out.byte(0x80 | 0x70 | (this.tableBits - 1));
    out.byte(0); // background colour index
    out.byte(0); // square pixels
    for (let i = 0; i < 1 << this.tableBits; i++) {
      const c = palette[i] ?? [0, 0, 0];
      out.byte(c[0]);
      out.byte(c[1]);
      out.byte(c[2]);
    }
    if (repeat >= 0) {
      out.byte(0x21);
      out.byte(0xff);
      out.byte(11);
      out.ascii('NETSCAPE2.0');
      out.byte(3);
      out.byte(1);
      out.u16(Math.min(0xffff, repeat));
      out.byte(0);
    }
  }

  /** Adds a frame covering `rect`; `indices` holds rect.width × rect.height palette indices, row-major. */
  writeFrame(indices: Uint8Array, rect: GifRect, options: GifFrameOptions): void {
    if (rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > this.width || rect.y + rect.height > this.height) {
      throw new RangeError(`Frame rectangle ${JSON.stringify(rect)} lies outside the ${this.width} × ${this.height} canvas.`);
    }
    if (indices.length < rect.width * rect.height) throw new RangeError('Not enough pixels for the frame rectangle.');
    const out = this.out;
    const transparent = options.transparentIndex !== undefined;
    // Graphic control extension: disposal, transparency, delay.
    out.byte(0x21);
    out.byte(0xf9);
    out.byte(4);
    out.byte(((options.disposal & 7) << 2) | (transparent ? 1 : 0));
    out.u16(Math.max(0, Math.min(0xffff, Math.round(options.delayCs))));
    out.byte(transparent ? options.transparentIndex! : 0);
    out.byte(0);
    // Image descriptor: position and size, no local table, not interlaced.
    out.byte(0x2c);
    out.u16(rect.x);
    out.u16(rect.y);
    out.u16(rect.width);
    out.u16(rect.height);
    out.byte(0);
    this.lzw.encode(indices, rect.width * rect.height, out);
  }

  /** Appends the trailer and returns the file. */
  finish(): Uint8Array<ArrayBuffer> {
    this.out.byte(0x3b);
    return this.out.result();
  }
}

/** Longest LZW code GIF allows. */
const MAX_CODE_BITS = 12;
const MAX_CODES = 1 << MAX_CODE_BITS;

/**
 * GIF-flavoured LZW (variable code width from minCodeSize + 1 up to 12 bits, a clear code when the
 * table is full), packed LSB-first into 255-byte sub-blocks. The string table is a direct lookup on
 * (prefix code, next index) with a generation stamp, so clearing it is O(1).
 */
class LzwEncoder {
  private readonly clearCode: number;
  private readonly endCode: number;
  private readonly codes = new Uint16Array(MAX_CODES << 8);
  private readonly stamps = new Uint32Array(MAX_CODES << 8);
  private generation = 0;
  private readonly block = new Uint8Array(256);

  constructor(private readonly minCodeSize: number) {
    this.clearCode = 1 << minCodeSize;
    this.endCode = this.clearCode + 1;
  }

  encode(indices: Uint8Array, length: number, out: ByteStream): void {
    const { clearCode, endCode, codes, stamps, block } = this;
    out.byte(this.minCodeSize);
    let blockLength = 0;
    let bitBuffer = 0;
    let bitCount = 0;
    let codeBits = this.minCodeSize + 1;
    let nextCode = endCode + 1;
    let generation = this.newGeneration();

    const emit = (code: number) => {
      bitBuffer |= code << bitCount;
      bitCount += codeBits;
      while (bitCount >= 8) {
        block[1 + blockLength++] = bitBuffer & 0xff;
        bitBuffer >>>= 8;
        bitCount -= 8;
        if (blockLength === 255) {
          block[0] = 255;
          out.write(block, 256);
          blockLength = 0;
        }
      }
    };

    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < length; i++) {
      const next = indices[i];
      const key = (prefix << 8) | next;
      if (stamps[key] === generation) {
        prefix = codes[key];
        continue;
      }
      emit(prefix);
      // The decoder widens its codes one code after the table outgrows the current width.
      if (nextCode === 1 << codeBits && codeBits < MAX_CODE_BITS) codeBits++;
      if (nextCode < MAX_CODES) {
        stamps[key] = generation;
        codes[key] = nextCode++;
      } else {
        emit(clearCode);
        generation = this.newGeneration();
        nextCode = endCode + 1;
        codeBits = this.minCodeSize + 1;
      }
      prefix = next;
    }
    emit(prefix);
    if (nextCode === 1 << codeBits && codeBits < MAX_CODE_BITS) codeBits++;
    emit(endCode);
    if (bitCount > 0) {
      block[1 + blockLength++] = bitBuffer & 0xff;
    }
    if (blockLength > 0) {
      block[0] = blockLength;
      out.write(block, blockLength + 1);
    }
    out.byte(0); // block terminator
  }

  private newGeneration(): number {
    this.generation = (this.generation + 1) >>> 0;
    if (this.generation === 0) {
      // Wrapped after 2^32 clears: forget every stamp so none can collide with the new generation.
      this.stamps.fill(0);
      this.generation = 1;
    }
    return this.generation;
  }
}
