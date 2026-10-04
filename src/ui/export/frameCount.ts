/**
 * How much of a clip an animated export covers and how many frames it writes, for the panel's
 * Frames fact, the trim switch and the encoder's progress.
 *
 *   exportRange(trimOnly, in, out)      the trim range, or the whole clip
 *   motionFrameCount(media, format, range, fps, frameTimes?)
 *   useFrameTimes()                     a video's real frame timestamps, once the player has indexed them
 *
 * A GIF source keeps its own frames. A video at a chosen rate is sampled at that rate. A video at
 * its own rate keeps its own (possibly variable) timestamps: exact once they are indexed, until
 * then estimated from the average rate and marked approximate.
 */
import { useSyncExternalStore } from 'react';
import { useRuntime } from '../../app/runtime';
import { animationSpans, gifFps, videoFrameTimes, type TimeRange } from '../../export/timing';
import type { ExportFormat } from '../../export/types';
import type { LoadedAnimation, LoadedVideo } from '../../media';

export interface FrameCount {
  count: number;
  /** An estimate from the average frame rate (variable-rate video before its frames are indexed). */
  approx: boolean;
}

/** The part of the clip an animated export covers: the trim range, or all of it. */
export function exportRange(trimOnly: boolean, inPoint: number, outPoint: number): TimeRange {
  return trimOnly ? { startSec: inPoint, endSec: outPoint } : {};
}

export function motionFrameCount(
  media: LoadedAnimation | LoadedVideo,
  format: ExportFormat,
  range: TimeRange,
  fps: number | 'source',
  frameTimes?: ArrayLike<number> | null,
): FrameCount {
  if (media.kind === 'animation') return { count: animationSpans(media.durations, range).length, approx: false };
  const requested = fps === 'source' ? undefined : fps;
  if (format === 'gif') return { count: videoFrameTimes(media.durationSec, range, gifFps(media.fps, requested)).length, approx: false };
  const start = Math.max(0, range.startSec ?? 0);
  const end = Math.min(media.durationSec, range.endSec ?? media.durationSec);
  if (requested) return { count: Math.max(1, Math.round((end - start) * requested)), approx: false };
  if (frameTimes) {
    let count = 0;
    for (let i = 0; i < frameTimes.length; i++) if (frameTimes[i] >= start && frameTimes[i] < end) count++;
    return { count: Math.max(1, count), approx: false };
  }
  return { count: Math.max(1, Math.round((end - start) * media.fps)), approx: true };
}

const NONE = () => () => undefined;

/** The open video's frame timestamps (null until indexed, and for GIFs and live sources). */
export function useFrameTimes(): Float64Array | null {
  const player = useRuntime((r) => r.player);
  return useSyncExternalStore(player ? (cb) => player.onStateChange(cb) : NONE, () => player?.frameTimes ?? null);
}
