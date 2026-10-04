/** Animated GIF → LoadedAnimation. gifuct-js on every browser so playback is identical everywhere. */
import { context2d } from './canvas';
import { FrameCache, frameCacheCapacity } from './frame-cache';
import { decodeGif, GifCompositor, type DecodedGif } from './gif-core';
import { CLOSED_MESSAGE, Lifetime } from './lifetime';
import { assertAnimationLimits } from './limits';
import { hasTransparentPixel } from './rgba';
import type { LoadedAnimation } from './types';

/** Upper bound on canvas checkpoints per GIF; sets how far a backward seek may have to replay. */
const CHECKPOINT_BUDGET_BYTES = 32 * 1024 * 1024;
const MIN_CHECKPOINT_INTERVAL = 8;
/** Longest stretch of synchronous compositing before yielding to keep the page responsive. */
const YIELD_AFTER_MS = 30;

export async function loadGif(bytes: Uint8Array, name: string): Promise<LoadedAnimation> {
  const gif = decodeGif(bytes);
  assertAnimationLimits(gif.width, gif.height, gif.frames.length);

  const frameBytes = gif.width * gif.height * 4;
  const interval = Math.max(
    MIN_CHECKPOINT_INTERVAL,
    Math.ceil((gif.frames.length * frameBytes) / CHECKPOINT_BUDGET_BYTES),
  );
  const compositor = new GifCompositor(gif, interval);
  const hasAlpha = await primeCompositor(compositor, gif);

  const canvas = new OffscreenCanvas(gif.width, gif.height);
  const ctx = context2d(canvas);
  // Wraps the compositor's reusable output buffer (no copy); refreshed by every frameAt() call.
  const imageData = new ImageData(compositor.output, gif.width, gif.height);
  const cache = new FrameCache<ImageBitmap>(frameCacheCapacity(frameBytes), (bitmap) => bitmap.close());
  const lifetime = new Lifetime(() => cache.dispose());
  // Synchronous from compositing to snapshot, so the shared output buffer and canvas can be reused at once.
  const composite = (i: number): ImageBitmap => {
    compositor.frameAt(i);
    ctx.putImageData(imageData, 0, 0);
    return canvas.transferToImageBitmap();
  };

  const durations = gif.frames.map((f) => f.delayMs);
  return {
    kind: 'animation',
    name,
    width: gif.width,
    height: gif.height,
    fileSize: bytes.byteLength,
    formatLabel: 'GIF',
    hasAlpha,
    frameCount: gif.frames.length,
    durations,
    totalMs: durations.reduce((sum, d) => sum + d, 0),
    loopCount: gif.loopCount,
    getFrame: (index) => cache.get(clampIndex(index, gif.frames.length), async (i) => composite(i)),
    readFrame: async (index) => {
      if (!lifetime.alive) throw new Error(CLOSED_MESSAGE);
      return composite(clampIndex(index, gif.frames.length));
    },
    ...lifetime.members(),
  };
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

/**
 * Composites every frame once at load: validates the whole file up front, fills the checkpoints so
 * any later seek is bounded, and finds out whether any displayed frame is actually transparent
 * (optimised GIFs use the transparent index for unchanged pixels, so the flag alone overstates it).
 */
async function primeCompositor(compositor: GifCompositor, gif: DecodedGif): Promise<boolean> {
  let hasAlpha = false;
  let sliceStart = performance.now();
  for (let i = 0; i < gif.frames.length; i++) {
    const rgba = compositor.frameAt(i);
    if (!hasAlpha) hasAlpha = hasTransparentPixel(rgba);
    if (performance.now() - sliceStart > YIELD_AFTER_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return hasAlpha;
}
