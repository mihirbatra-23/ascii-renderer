/**
 * Whether Tone should suggest Invert for the open still (./lightImage). The image is sampled once
 * per file; the decision is re-made against the live tone settings, so the hint goes away as soon
 * as the image no longer maps to a wall of dense glyphs (or Invert is on).
 */
import { useEffect, useState } from 'react';
import { useRuntime } from '../../app/runtime';
import { measureLevels, type Levels, type RenderParams } from '../../engine';
import type { LoadedImage } from '../../media';
import { useStore } from '../../state/store';
import { invertHint, medianInk, sampleLumaAlpha, type LumaAlphaSample } from './lightImage';

interface Measured {
  media: LoadedImage;
  sample: LumaAlphaSample;
  levels: Levels;
}

/** A 512 px copy is plenty for a 256 px area-filtered sample and keeps 100 MP files cheap. */
const COPY_EDGE = 512;

function measure(media: LoadedImage): Measured {
  const s = Math.min(1, COPY_EDGE / Math.max(media.width, media.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(media.width * s)), Math.max(1, Math.round(media.height * s)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(media.bitmap, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { media, sample: sampleLumaAlpha(data, width, height), levels: measureLevels(data, width, height) };
}

let memo: { measured: Measured; params: RenderParams; hint: ReturnType<typeof invertHint> } | null = null;

function hintFor(measured: Measured, params: RenderParams): ReturnType<typeof invertHint> {
  if (memo?.measured !== measured || memo.params !== params) {
    memo = { measured, params, hint: invertHint(medianInk(measured.sample, params, measured.levels), params) };
  }
  return memo.hint;
}

export function useInvertHint(): 'light' | 'dark' | null {
  const media = useRuntime((r) => r.media);
  const [measured, setMeasured] = useState<Measured | null>(null);

  useEffect(() => {
    if (media?.kind !== 'image') return;
    // A task after the new file's first paint, off the opening's critical path.
    const timer = setTimeout(() => {
      try {
        setMeasured(measure(media));
      } catch {
        // No 2D canvas (or a closed bitmap): no hint, nothing else depends on it.
      }
    });
    return () => clearTimeout(timer);
  }, [media]);

  return useStore((s) => (measured && measured.media === media ? hintFor(measured, s.params) : null));
}
