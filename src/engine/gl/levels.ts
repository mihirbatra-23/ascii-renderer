/**
 * Auto-levels from frames (browser): docs/ALGORITHM.md §3 measures once per still and once per
 * clip from ~8 frames spread across it; this turns those frames into one Levels.
 *
 * Public API
 *   measureFrameLevels(frames)   → Levels (p1 / p99 over all frames together)
 */
import type { FrameSource, Levels } from '../types';
import { measureLevels } from '../tone';
import { createRasterCanvas, fittedSize, frameSize } from './frame';

/** measureLevels analyses a ≤ 256 px downsample, so larger tiles add nothing. */
const TILE_EDGE = 256;

/** Frames are tiled into one near-square sheet, so the percentiles cover every frame's pixels. */
export function measureFrameLevels(frames: readonly FrameSource[]): Levels {
  const sized = frames.map((f) => ({ f, ...frameSize(f) })).filter((f) => f.width > 0 && f.height > 0);
  if (sized.length === 0) return { black: 0, white: 1 };
  const tile = fittedSize(sized[0].width, sized[0].height, TILE_EDGE);
  const across = Math.ceil(Math.sqrt(sized.length));
  const down = Math.ceil(sized.length / across);
  const { ctx } = createRasterCanvas(tile.width * across, tile.height * down);
  sized.forEach(({ f }, i) => ctx.drawImage(f, (i % across) * tile.width, Math.floor(i / across) * tile.height, tile.width, tile.height));
  // Unused cells of the sheet stay transparent, and measureLevels ignores transparent pixels.
  const { width, height } = ctx.canvas;
  return measureLevels(ctx.getImageData(0, 0, width, height).data, width, height);
}
