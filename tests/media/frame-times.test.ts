import { describe, expect, it } from 'vitest';
import { frameIndexAtTime, frameMidTime, stepFrameIndex } from '../../src/media/frame-times';

/** A 120 Hz-timebase phone clip: gaps of 8.3 / 16.7 / 25 / 33 ms, average ≈ 54 fps (siri_portrait_8s). */
function vfrTimes(n: number): Float64Array {
  const gaps = [2, 2, 3, 2, 1, 2, 4, 2, 2, 3, 2, 2];
  const out = new Float64Array(n);
  let ticks = 2; // the first frame is at 2/120 s, as in the real file
  for (let i = 0; i < n; i++) {
    out[i] = ticks / 120;
    ticks += gaps[i % gaps.length];
  }
  return out;
}

describe('frame timestamps (VFR stepping)', () => {
  const times = vfrTimes(200);
  const duration = times[times.length - 1] + 1 / 60;

  it('finds the frame on screen at a time, tolerant of rounding', () => {
    expect(frameIndexAtTime(times, 0)).toBe(0);
    expect(frameIndexAtTime(times, times[5])).toBe(5);
    expect(frameIndexAtTime(times, times[5] - 1e-5)).toBe(5);
    expect(frameIndexAtTime(times, (times[5] + times[6]) / 2)).toBe(5);
    expect(frameIndexAtTime(times, 1e9)).toBe(199);
  });

  it('seeks into the middle of a frame, the last one lasting to the end of the clip', () => {
    expect(frameMidTime(times, 3, duration)).toBeCloseTo((times[3] + times[4]) / 2, 9);
    expect(frameMidTime(times, 199, duration)).toBeCloseTo((times[199] + duration) / 2, 9);
  });

  it('60 single steps visit 60 consecutive frames (the average-fps rule repeated and skipped 14 of 60)', () => {
    let t = frameMidTime(times, 0, duration);
    const visited: number[] = [];
    for (let k = 0; k < 60; k++) {
      const index = stepFrameIndex(times, t, 1, 0, duration);
      t = frameMidTime(times, index, duration);
      visited.push(index);
    }
    expect(visited).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    // And back again.
    for (let k = 0; k < 60; k++) t = frameMidTime(times, stepFrameIndex(times, t, -1, 0, duration), duration);
    expect(frameIndexAtTime(times, t)).toBe(0);
  });

  it('stays inside the trim range', () => {
    const inSec = times[10];
    const outSec = times[20];
    expect(stepFrameIndex(times, times[15], 100, inSec, outSec)).toBe(19);
    expect(stepFrameIndex(times, times[15], -100, inSec, outSec)).toBe(10);
    // A trim point inside a frame keeps that frame.
    expect(stepFrameIndex(times, times[15], -100, (times[10] + times[11]) / 2, outSec)).toBe(10);
  });
});
