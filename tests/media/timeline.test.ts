import { describe, expect, it } from 'vitest';
import { spreadIndices } from '../../src/media/levels';
import { browserFrameDelayMs, frameIndexAt, frameRange, frameStartTimes, wrapPlaybackTime } from '../../src/media/timeline';

describe('browserFrameDelayMs', () => {
  it.each([[0, 100], [10, 100], [11, 11], [20, 20], [40, 40], [1000, 1000]])('%i ms → %i ms', (declared, shown) => {
    expect(browserFrameDelayMs(declared)).toBe(shown);
  });
});

describe('frame timing', () => {
  const starts = frameStartTimes([120, 40, 120, 40]);

  it('accumulates start times with the total at the end', () => {
    expect(Array.from(starts)).toEqual([0, 120, 160, 280, 320]);
  });

  it.each([
    [-5, 0],
    [0, 0],
    [119.9, 0],
    [120, 1],
    [159.999, 1],
    [160, 2],
    [319, 3],
    [320, 3],
    [10_000, 3],
  ])('frame at %f ms is %i', (ms, index) => {
    expect(frameIndexAt(starts, ms)).toBe(index);
  });

  it('frameRange covers frames overlapping [in, out)', () => {
    expect(frameRange(starts, 0, 0.32)).toEqual({ first: 0, last: 3 });
    expect(frameRange(starts, 0.13, 0.28)).toEqual({ first: 1, last: 2 });
    expect(frameRange(starts, 0.12, 0.2)).toEqual({ first: 1, last: 2 });
    expect(frameRange(starts, 0.12, 0.16)).toEqual({ first: 1, last: 1 });
  });

  it('handles a single frame', () => {
    const one = frameStartTimes([100]);
    expect(frameIndexAt(one, 50)).toBe(0);
    expect(frameRange(one, 0, 0.1)).toEqual({ first: 0, last: 0 });
  });
});

describe('wrapPlaybackTime', () => {
  it('passes through inside the range', () => {
    expect(wrapPlaybackTime(1.5, 1, 3, true)).toEqual({ time: 1.5, ended: false });
  });

  it('wraps with modulo when looping, without drift over many loops', () => {
    expect(wrapPlaybackTime(3.5, 1, 3, true).time).toBeCloseTo(1.5, 12);
    expect(wrapPlaybackTime(1 + 2 * 1000 + 0.25, 1, 3, true).time).toBeCloseTo(1.25, 9);
  });

  it('ends at the out point when not looping', () => {
    expect(wrapPlaybackTime(3.01, 1, 3, false)).toEqual({ time: 3, ended: true });
  });
});

describe('spreadIndices (frames sampled for auto-levels)', () => {
  it('takes slice centres across the clip', () => {
    expect(spreadIndices(200, 8)).toEqual([12, 37, 62, 87, 112, 137, 162, 187]);
  });

  it('returns every frame of short clips', () => {
    expect(spreadIndices(3, 8)).toEqual([0, 1, 2]);
  });
});
