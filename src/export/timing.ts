/** Frame timing for animated exports (pure: trim ranges, frame rates, frame times). */

export interface TimeRange {
  startSec?: number;
  endSec?: number;
}

/** GIFs default to the source rate capped at 25 fps; requests are capped at 50 fps (2 cs, the GIF minimum). */
export function gifFps(sourceFps: number, requested?: number): number {
  const fps = requested ?? Math.min(sourceFps, 25);
  return Math.max(1, Math.min(50, fps));
}

/**
 * NETSCAPE repeat count for a GIF that plays `plays` times in all (LoadedAnimation.loopCount:
 * 0 = forever). Browsers play a GIF with repeat count n n + 1 times and one without the extension
 * once, so one play is no extension (-1) and n plays are n − 1 repeats.
 */
export function gifRepeatCount(plays: number): number {
  const n = Math.round(plays);
  if (!(n >= 1)) return 0;
  return n === 1 ? -1 : Math.min(n - 1, 0xffff);
}

export function clampRange(range: TimeRange, durationSec: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(durationSec, range.startSec ?? 0));
  const end = Math.max(start, Math.min(durationSec, range.endSec ?? durationSec));
  return { start, end };
}

/** The part of each animation frame inside the trim range, as [index, visible ms] pairs. */
export function animationSpans(durations: readonly number[], range: TimeRange = {}): Array<[number, number]> {
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const { start, end } = clampRange(range, totalMs / 1000);
  const spans: Array<[number, number]> = [];
  let t = 0;
  durations.forEach((d, i) => {
    const visible = Math.min(t + d, end * 1000) - Math.max(t, start * 1000);
    if (visible > 0) spans.push([i, visible]);
    t += d;
  });
  return spans;
}

/** Output frame times for a video sampled at a constant rate inside the trim range. */
export function videoFrameTimes(durationSec: number, range: TimeRange, fps: number): number[] {
  const { start, end } = clampRange(range, durationSec);
  const times: number[] = [];
  // The epsilon keeps float error from adding a frame that would start exactly at `end`.
  for (let i = 0; start + i / fps < end - 1e-6; i++) times.push(start + i / fps);
  return times;
}

/** `count` times at the centres of equal slices of the trim range (frames sampled across a clip). */
export function spreadTimes(durationSec: number, range: TimeRange, count: number): number[] {
  const { start, end } = clampRange(range, durationSec);
  if (!(end > start) || count < 1) return [];
  return Array.from({ length: count }, (_, k) => start + ((k + 0.5) * (end - start)) / count);
}
