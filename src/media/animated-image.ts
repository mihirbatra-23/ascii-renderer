/**
 * Animated WebP / APNG / AVIF via WebCodecs ImageDecoder, which composites frames (blend and
 * dispose ops) natively. Callers check supportsAnimatedDecode() first and otherwise fall back to
 * the first frame as a still.
 */
import { hasVisibleAlpha } from './canvas';
import { FrameCache, frameCacheCapacity } from './frame-cache';
import { readImageHeader } from './header';
import { imageMimeType } from './image';
import { CLOSED_MESSAGE, Lifetime } from './lifetime';
import { assertAnimationLimits, assertImagePixels } from './limits';
import { browserFrameDelayMs } from './timeline';
import { MediaError, type LoadedAnimation } from './types';

export async function supportsAnimatedDecode(format: string): Promise<boolean> {
  return 'ImageDecoder' in globalThis && ImageDecoder.isTypeSupported(imageMimeType(format));
}

export async function loadAnimatedImage(bytes: Uint8Array, name: string, format: string): Promise<LoadedAnimation> {
  const header = readImageHeader(bytes, format);
  if (header) assertImagePixels(header.width, header.height);

  const decoder = new ImageDecoder({
    data: bytes,
    type: imageMimeType(format),
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
    preferAnimation: true,
  });
  try {
    await decoder.tracks.ready;
    await decoder.completed; // frameCount is final only once all data is parsed
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount === 0) throw new Error('No image track.');

    // Durations are only exposed per decoded frame, so walk the clip once (frames are not kept).
    const durations: number[] = [];
    let width = 0;
    let height = 0;
    let hasAlpha = false;
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        if (i === 0) {
          width = image.displayWidth;
          height = image.displayHeight;
          assertAnimationLimits(width, height, track.frameCount);
          hasAlpha = (header?.mayHaveAlpha ?? true) && hasVisibleAlpha(image, width, height);
        }
        durations.push(browserFrameDelayMs((image.duration ?? 0) / 1000));
      } finally {
        image.close();
      }
    }

    const cache = new FrameCache<ImageBitmap>(frameCacheCapacity(width * height * 4), (b) => b.close());
    const lifetime = new Lifetime(() => {
      cache.dispose();
      decoder.close();
    });
    const decodeFrame = async (index: number): Promise<ImageBitmap> => {
      const { image } = await decoder.decode({ frameIndex: Math.max(0, Math.min(durations.length - 1, Math.trunc(index))) });
      try {
        return await createImageBitmap(image, { premultiplyAlpha: 'none' });
      } finally {
        image.close();
      }
    };
    return {
      kind: 'animation',
      name,
      width,
      height,
      fileSize: bytes.byteLength,
      formatLabel: format,
      hasAlpha,
      frameCount: durations.length,
      durations,
      totalMs: durations.reduce((sum, d) => sum + d, 0),
      // ImageDecoder reports repeats; the contract counts total plays (0 = forever).
      loopCount: Number.isFinite(track.repetitionCount) ? track.repetitionCount + 1 : 0,
      getFrame: (index) => cache.get(Math.max(0, Math.min(durations.length - 1, Math.trunc(index))), decodeFrame),
      readFrame: (index) => (lifetime.alive ? decodeFrame(index) : Promise.reject(new Error(CLOSED_MESSAGE))),
      ...lifetime.members(),
    };
  } catch (error) {
    decoder.close();
    if (error instanceof MediaError) throw error;
    throw new MediaError('decode-failed', 'The file may be damaged.');
  }
}
