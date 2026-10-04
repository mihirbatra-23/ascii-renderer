/** Pure timing math for frame-based animations (GIF, animated WebP / APNG / AVIF). */

/**
 * Browser-compatible frame delay: Chromium, Firefox and Safari show frames that declare ≤ 10 ms
 * (including 0) for 100 ms, because such files were authored for decoders that ignored tiny delays.
 */
export function browserFrameDelayMs(declaredMs: number): number {
  return declaredMs <= 10 ? 100 : declaredMs;
}

/** Cumulative start times in ms; the extra last entry is the total duration. */
export function frameStartTimes(durationsMs: readonly number[]): Float64Array {
  const starts = new Float64Array(durationsMs.length + 1);
  for (let i = 0; i < durationsMs.length; i++) starts[i + 1] = starts[i] + durationsMs[i];
  return starts;
}

/** Index of the frame shown at `ms` (clamped to the first / last frame). */
export function frameIndexAt(starts: Float64Array, ms: number): number {
  const last = starts.length - 2;
  if (last < 0) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * First and last frame visible inside a trim range [inSec, outSec): a frame belongs to the range
 * when any part of its display interval lies inside it.
 */
export function frameRange(starts: Float64Array, inSec: number, outSec: number): { first: number; last: number } {
  const first = frameIndexAt(starts, inSec * 1000);
  // The frame containing the instant just before outSec.
  const last = Math.max(first, frameIndexAt(starts, outSec * 1000 - 1e-6));
  return { first, last };
}

/**
 * Maps an unbounded media clock `t` (seconds, derived from the wall-clock time since play started)
 * into the trim range. Looping wraps with a modulo of that clock, so there is no accumulated drift.
 */
export function wrapPlaybackTime(
  t: number,
  inSec: number,
  outSec: number,
  loop: boolean,
): { time: number; ended: boolean } {
  if (t < outSec) return { time: Math.max(t, inSec), ended: false };
  if (!loop) return { time: outSec, ended: true };
  const span = outSec - inSec;
  return { time: span > 0 ? inSec + ((t - inSec) % span) : inSec, ended: false };
}
