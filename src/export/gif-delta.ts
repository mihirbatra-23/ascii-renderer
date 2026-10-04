/**
 * Inter-frame deltas for GIF: each frame after the first stores only the bounding rectangle of the
 * pixels that changed, with unchanged pixels inside it set to a reserved transparent index (drawn
 * over the previous frame, disposal 1). ASCII video changes a few percent of its pixels per frame,
 * so this shrinks files 5–10× against full opaque frames.
 */
import type { GifRect } from './gif-writer';

export interface GifDelta {
  rect: GifRect;
  /** rect.width × rect.height palette indices, row-major. */
  indices: Uint8Array;
  /** Whether `indices` uses the transparent index (every frame but the first). */
  transparent: boolean;
}

export class FrameDiffer {
  private previous: Uint8Array | null = null;
  private scratch = new Uint8Array(0);

  constructor(
    private readonly width: number,
    private readonly height: number,
    /** Reserved palette index that no real colour maps to. */
    private readonly transparentIndex: number,
  ) {}

  /** The part of `frame` (full-canvas indices) to write; remembers `frame` for the next call. */
  next(frame: Uint8Array): GifDelta {
    const { width, height } = this;
    const prev = this.previous;
    if (!prev) {
      this.previous = frame.slice();
      return { rect: { x: 0, y: 0, width, height }, indices: frame, transparent: false };
    }

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let x0 = -1;
      let x1 = -1;
      for (let x = 0; x < width; x++) {
        if (frame[row + x] !== prev[row + x]) {
          if (x0 < 0) x0 = x;
          x1 = x;
        }
      }
      if (x0 < 0) continue;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (minY === height) minY = y;
      maxY = y;
    }

    if (maxX < 0) {
      // Nothing changed: a single transparent pixel keeps the frame (and its delay) in the file.
      return { rect: { x: 0, y: 0, width: 1, height: 1 }, indices: Uint8Array.of(this.transparentIndex), transparent: true };
    }

    const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    if (this.scratch.length < rect.width * rect.height) this.scratch = new Uint8Array(width * height);
    const out = this.scratch;
    let o = 0;
    for (let y = rect.y; y <= maxY; y++) {
      const row = y * width;
      for (let x = rect.x; x <= maxX; x++, o++) {
        const i = row + x;
        const v = frame[i];
        out[o] = v === prev[i] ? this.transparentIndex : v;
        prev[i] = v;
      }
    }
    return { rect, indices: out.subarray(0, o), transparent: true };
  }
}
