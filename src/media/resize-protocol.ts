/** Messages between image.ts and resize.worker.ts. */

export interface PixelBox {
  width: number;
  height: number;
}

export interface ResizeRequest {
  bitmap: ImageBitmap;
  /** Size to keep the picture at, or null to keep it as it is. */
  source: PixelBox | null;
  /** Size of the analysis thumbnail, or null when the (kept) picture is small enough to be its own. */
  thumbnail: PixelBox | null;
}

export type ResizeReply = { ok: true; bitmap: ImageBitmap; thumbnail: ImageBitmap } | { ok: false; bitmap: ImageBitmap; message: string };
