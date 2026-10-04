/**
 * Resizes a decoded still off the main thread. Chrome runs createImageBitmap(bitmap, { resizeWidth })
 * on the calling thread: 250 ms for an 8000 × 8000 PNG to 4096 px. Here it costs the page
 * nothing; the bitmaps travel by transfer, never by copy.
 */
import type { ResizeReply, ResizeRequest } from './resize-protocol';

function resized(bitmap: ImageBitmap, size: { width: number; height: number }, quality: ResizeQuality): Promise<ImageBitmap> {
  return createImageBitmap(bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: quality, premultiplyAlpha: 'none' });
}

self.onmessage = async (event: MessageEvent<ResizeRequest>) => {
  const { bitmap, source, thumbnail } = event.data;
  let reply: ResizeReply;
  try {
    const kept = source ? await resized(bitmap, source, 'high') : bitmap;
    const thumb = thumbnail ? await resized(kept, thumbnail, 'medium') : kept;
    if (kept !== bitmap) bitmap.close();
    reply = { ok: true, bitmap: kept, thumbnail: thumb };
  } catch (error) {
    // The original goes back untouched, so the caller can still use it.
    reply = { ok: false, bitmap, message: error instanceof Error ? error.message : String(error) };
  }
  const transfer = reply.ok && reply.thumbnail !== reply.bitmap ? [reply.bitmap, reply.thumbnail] : [reply.bitmap];
  self.postMessage(reply, { transfer });
};
