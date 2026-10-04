/**
 * The loaded clip as the transport sees it: frame index at a time, frame start times, and the
 * readouts' formats. Animations use their real (variable) frame delays; video uses its real frame
 * timestamps once the player has indexed them (Player.frameTimes), the average frame rate until
 * then, as VideoPlayer.step does.
 */
import type { LoadedAnimation, LoadedVideo } from '../../media';
import { frameIndexAt, frameStartTimes } from '../../media/timeline';

export interface Clip {
  /** Seconds. */
  duration: number;
  frameCount: number;
  /** Index of the frame on screen at `t` seconds. */
  frameAt(t: number): number;
  /** Start of frame `i` in seconds; `frameStart(frameCount)` is the duration. */
  frameStart(i: number): number;
  /** A time that lands safely inside frame `i` (seek target). */
  frameTime(i: number): number;
}

const clampInt = (i: number, max: number) => Math.min(max, Math.max(0, Math.trunc(i)));

export function clipOf(media: LoadedAnimation | LoadedVideo, frameTimes?: Float64Array | null): Clip {
  if (media.kind === 'animation') return startsClip(frameStartTimes(media.durations), media.totalMs / 1000, false);
  const { durationSec: duration, fps } = media;
  if (frameTimes?.length) {
    // Start times in ms with the duration as the closing entry, the layout frameIndexAt expects.
    const starts = new Float64Array(frameTimes.length + 1);
    frameTimes.forEach((t, i) => (starts[i] = t * 1000));
    starts[frameTimes.length] = Math.max(duration, frameTimes[frameTimes.length - 1]) * 1000;
    return startsClip(starts, duration, true);
  }
  const n = Math.max(1, Math.round(duration * fps));
  return {
    duration,
    frameCount: n,
    // The epsilon keeps a time exactly on a frame boundary from rounding into the previous frame.
    frameAt: (t) => clampInt(t * fps + 1e-3, n - 1),
    frameStart: (i) => Math.min(duration, clampInt(i, n) / fps),
    // Mid-frame, so container timestamp rounding cannot land on the previous frame.
    frameTime: (i) => Math.min(duration, (clampInt(i, n - 1) + 0.5) / fps),
  };
}

/**
 * A clip from frame start times (ms; the last entry is the end). Video seeks aim mid-frame, so a
 * container timestamp rounding down cannot land on the previous frame; animations are exact.
 */
function startsClip(starts: Float64Array, duration: number, midFrameSeeks: boolean): Clip {
  const n = starts.length - 1;
  const frameStart = (i: number) => starts[clampInt(i, n)] / 1000;
  return {
    duration,
    frameCount: n,
    frameAt: (t) => frameIndexAt(starts, t * 1000),
    frameStart,
    frameTime: midFrameSeeks
      ? (i) => {
          const k = clampInt(i, n - 1);
          return (starts[k] + starts[k + 1]) / 2000;
        }
      : frameStart,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** '01:02.42' (minutes, seconds, hundredths). */
export function formatTimecode(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${pad2(Math.floor(cs / 6000))}:${pad2(Math.floor(cs / 100) % 60)}.${pad2(cs % 100)}`;
}

/** Accepts '01:02.42', '1:02', '62.42', '2.5s'; null when it is not a time. */
export function parseTimecode(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:[.,]\d*)?)\s*s?\s*$/i.exec(text);
  if (!m) return null;
  const sec = Number(m[2].replace(',', '.')) + (m[1] ? Number(m[1]) * 60 : 0);
  return Number.isFinite(sec) ? sec : null;
}

/** Frame numbers are 1-based on screen and padded to the width of the total ('034 / 096'). */
export function padFrame(n: number, total: number): string {
  return String(n).padStart(Math.max(3, String(total).length), '0');
}
