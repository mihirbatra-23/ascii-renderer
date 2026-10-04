/**
 * GIF decoding (gifuct-js) and frame compositing on plain RGBA buffers. DOM-free so it runs in
 * Node tests and could move to a worker unchanged.
 *
 * Memory model: frames stay LZW-compressed as parsed (≈ the file size). Palette indices for a
 * frame's own rectangle are decoded on demand into a bounded LRU (1 byte per patch pixel), and
 * composited RGBA frames are rebuilt from periodic checkpoints of the canvas state. A
 * 1000 × 1000 × 300-frame GIF therefore needs about its file size plus the two budgets
 * (INDEX_CACHE_BYTES, the loader's checkpoint budget) instead of 1.2 GB of RGBA frames.
 */
import { decompressFrame, parseGIF, type ParsedGif } from 'gifuct-js';
import { GIF_NO_FRAMES } from './detect';
import { MediaError } from './types';
import { browserFrameDelayMs } from './timeline';

export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Decodes the palette indices (row-major, deinterlaced). Each call decodes afresh. */
  decodeIndices(): Uint8Array;
  /** RGB triplets (local table, else the global one); null when the file has neither. */
  palette: Uint8Array | null;
  /** -1 when the frame has no transparent colour. */
  transparentIndex: number;
  /** 0/1 keep, 2 restore to background (transparent), 3 restore to previous; 4–7 behave like 1. */
  disposal: number;
  /** Display duration with browser clamping applied. */
  delayMs: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: GifFrame[];
  /** 0 = forever; otherwise total plays (NETSCAPE count n → n + 1 plays, no extension → 1), as browsers do. */
  loopCount: number;
}

/** Runtime shape of gifuct-js blocks (its typings declare `gce` as always present, which is not true). */
interface RawBlock {
  gce?: {
    delay: number;
    transparentColorIndex: number;
    extras: { disposal: number; transparentColorGiven: boolean };
  };
  image?: {
    descriptor: { left: number; top: number; width: number; height: number; lct: { exists: boolean } };
    lct?: [number, number, number][];
  };
  application?: { id: string; blocks: Uint8Array | number[] };
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let parsed: ParsedGif;
  try {
    parsed = parseGIF(toArrayBuffer(bytes));
  } catch {
    throw new MediaError('decode-failed', 'The GIF is damaged.');
  }
  const globalPalette = parsed.lsd.gct.exists ? paletteBytes(parsed.gct) : null;
  const gct = parsed.gct;
  const frames: GifFrame[] = [];
  let loopCount = 1;

  for (const block of parsed.frames as unknown as RawBlock[]) {
    const app = block.application;
    if (app && (app.id === 'NETSCAPE2.0' || app.id === 'ANIMEXTS1.0') && app.blocks[0] === 1) {
      const count = app.blocks[1] | (app.blocks[2] << 8);
      loopCount = count === 0 ? 0 : count + 1;
    }
    const image = block.image;
    if (!image) continue;
    const { left, top, width, height } = image.descriptor;
    const gce = block.gce;
    // Keep only the image part: other parsed fields are subarray views that would pin the whole file.
    const imageOnly = { image } as unknown as Parameters<typeof decompressFrame>[0];
    frames.push({
      left,
      top,
      width,
      height,
      // gifuct-js does LZW + deinterlacing; its RGBA patch builder is skipped in favour of 1-byte indices.
      decodeIndices: () => Uint8Array.from(decompressFrame(imageOnly, gct, false).pixels),
      palette: image.descriptor.lct.exists && image.lct ? paletteBytes(image.lct) : globalPalette,
      transparentIndex: gce?.extras.transparentColorGiven ? gce.transparentColorIndex : -1,
      disposal: gce?.extras.disposal ?? 0,
      delayMs: browserFrameDelayMs((gce?.delay ?? 0) * 10),
    });
  }

  if (frames.length === 0) throw new MediaError('decode-failed', GIF_NO_FRAMES);
  // A zero logical screen (seen in broken encoders) falls back to the first frame's extent, like browsers.
  const first = frames[0];
  const width = parsed.lsd.width || first.left + first.width;
  const height = parsed.lsd.height || first.top + first.height;
  return { width, height, frames, loopCount };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
    ? buffer
    : bytes.slice().buffer;
}

function paletteBytes(table: readonly (readonly number[])[]): Uint8Array {
  const out = new Uint8Array(table.length * 3);
  table.forEach((rgb, i) => out.set(rgb.slice(0, 3), i * 3));
  return out;
}

/**
 * One compositing step. On entry `state` holds the canvas before frame `frame` is drawn; on return
 * `out` holds the displayed frame and `state` holds the canvas after the frame's disposal, ready
 * for the next frame. Both buffers are canvasWidth × canvasHeight RGBA; `indices` are the frame's.
 */
export function compositeStep(
  state: Uint8ClampedArray,
  out: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  frame: GifFrame,
  indices: Uint8Array,
): void {
  out.set(state);
  drawPatch(out, canvasWidth, canvasHeight, frame, indices);
  if (frame.disposal === 3) return; // restore to previous: state already is the previous canvas
  state.set(out);
  if (frame.disposal === 2) clearRect(state, canvasWidth, canvasHeight, frame);
}

function drawPatch(target: Uint8ClampedArray, cw: number, ch: number, f: GifFrame, indices: Uint8Array): void {
  const palette = f.palette;
  if (!palette) return;
  const colors = palette.length / 3;
  const visibleW = Math.min(f.width, cw - f.left);
  const visibleH = Math.min(f.height, ch - f.top);
  for (let y = 0; y < visibleH; y++) {
    let src = y * f.width;
    let dst = ((f.top + y) * cw + f.left) * 4;
    for (let x = 0; x < visibleW; x++, src++, dst += 4) {
      const index = indices[src];
      // Like Chromium, indices past the colour table are treated as transparent.
      if (index === f.transparentIndex || index >= colors) continue;
      const p = index * 3;
      target[dst] = palette[p];
      target[dst + 1] = palette[p + 1];
      target[dst + 2] = palette[p + 2];
      target[dst + 3] = 255;
    }
  }
}

function clearRect(target: Uint8ClampedArray, cw: number, ch: number, f: GifFrame): void {
  const visibleW = Math.max(0, Math.min(f.width, cw - f.left));
  const visibleH = Math.min(f.height, ch - f.top);
  for (let y = 0; y < visibleH; y++) {
    const start = ((f.top + y) * cw + f.left) * 4;
    target.fill(0, start, start + visibleW * 4);
  }
}

/**
 * Random access to composited frames. Sequential access costs one compositing step per frame;
 * seeking backwards replays at most `checkpointInterval - 1` frames from the nearest checkpoint.
 */
/** Decoded palette indices kept per GIF: typical GIFs fit entirely, so each frame is decoded once. */
export const INDEX_CACHE_BYTES = 32 * 1024 * 1024;

export class GifCompositor {
  readonly width: number;
  readonly height: number;
  /** Composited RGBA of the frame from the last frameAt() call; overwritten by the next call. */
  readonly output: Uint8ClampedArray<ArrayBuffer>;
  private readonly state: Uint8ClampedArray<ArrayBuffer>;
  /** `state` holds the canvas before frame `cursor`. */
  private cursor = 0;
  private outputIndex = -1;
  /** Canvas before frame k, for k a multiple of the interval (k = 0 is the empty canvas). */
  private readonly checkpoints = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
  /** LRU (Map insertion order) of decoded indices, bounded by `indexCacheBytes`. */
  private readonly indexCache = new Map<number, Uint8Array>();
  private indexCacheSize = 0;

  constructor(
    private readonly gif: DecodedGif,
    private readonly checkpointInterval: number,
    private readonly indexCacheBytes = INDEX_CACHE_BYTES,
  ) {
    this.width = gif.width;
    this.height = gif.height;
    this.output = new Uint8ClampedArray(gif.width * gif.height * 4);
    this.state = new Uint8ClampedArray(gif.width * gif.height * 4);
  }

  frameAt(index: number): Uint8ClampedArray<ArrayBuffer> {
    const i = Math.max(0, Math.min(this.gif.frames.length - 1, Math.trunc(index)));
    if (i === this.outputIndex) return this.output;
    const checkpoint = this.latestCheckpoint(i);
    // Walk forward from wherever is closer: the current cursor (if not past i) or the checkpoint.
    if (this.cursor > i || this.cursor < checkpoint) {
      const snapshot = this.checkpoints.get(checkpoint);
      if (snapshot) this.state.set(snapshot);
      else this.state.fill(0);
      this.cursor = checkpoint;
    }
    while (this.cursor <= i) {
      const frame = this.gif.frames[this.cursor];
      compositeStep(this.state, this.output, this.width, this.height, frame, this.indicesOf(this.cursor));
      this.cursor++;
      if (this.cursor % this.checkpointInterval === 0 && !this.checkpoints.has(this.cursor)) {
        this.checkpoints.set(this.cursor, this.state.slice());
      }
    }
    this.outputIndex = i;
    return this.output;
  }

  private indicesOf(i: number): Uint8Array {
    const cached = this.indexCache.get(i);
    if (cached) {
      this.indexCache.delete(i);
      this.indexCache.set(i, cached);
      return cached;
    }
    const indices = this.gif.frames[i].decodeIndices();
    this.indexCache.set(i, indices);
    this.indexCacheSize += indices.length;
    for (const [k, evicted] of this.indexCache) {
      if (this.indexCacheSize <= this.indexCacheBytes || k === i) break;
      this.indexCache.delete(k);
      this.indexCacheSize -= evicted.length;
    }
    return indices;
  }

  /** Latest stored checkpoint index ≤ i; 0 (the empty canvas) when none is stored yet. */
  private latestCheckpoint(i: number): number {
    let k = i - (i % this.checkpointInterval);
    while (k > 0 && !this.checkpoints.has(k)) k -= this.checkpointInterval;
    return k;
  }
}
