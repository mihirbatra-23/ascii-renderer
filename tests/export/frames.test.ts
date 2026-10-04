import { describe, expect, it, vi } from 'vitest';
import { animationFrames, animationSamples, framesAtTimes } from '../../src/export/frames';
import { spreadTimes } from '../../src/export/timing';
import type { LoadedAnimation } from '../../src/media/types';

/** A fake animation whose readFrame hands out closable frames and whose retains are counted. */
function fakeAnimation(durations: number[]) {
  const frames: Array<{ index: number; closed: boolean; close: () => void }> = [];
  const state = { holds: 0, released: 0 };
  const anim = {
    kind: 'animation',
    width: 4,
    height: 2,
    durations,
    frameCount: durations.length,
    readFrame: vi.fn(async (index: number) => {
      const frame = { index, closed: false, close: () => (frame.closed = true) };
      frames.push(frame);
      return frame as unknown as ImageBitmap;
    }),
    retain: () => {
      state.holds++;
      return () => {
        state.holds--;
        state.released++;
      };
    },
  } as unknown as LoadedAnimation;
  return { anim, frames, state };
}

async function* stream(timestamps: number[]) {
  for (const timestamp of timestamps) yield { timestamp };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('animationFrames / animationSamples', () => {
  it('yields owned frames that stay valid until the next request, then closes them', async () => {
    const { anim, frames, state } = fakeAnimation([100, 40, 120]);
    const it = animationFrames(anim)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.durationMs).toBe(100);
    expect(state.holds).toBe(1);
    expect(frames[0].closed).toBe(false);
    await it.next();
    expect(frames[0].closed).toBe(true);
    expect(frames[1].closed).toBe(false);
    await it.next();
    expect((await it.next()).done).toBe(true);
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(state.holds).toBe(0);
  });

  it('releases the frame and the media when the consumer stops early', async () => {
    const { anim, frames, state } = fakeAnimation([10, 10, 10, 10]);
    const it = animationFrames(anim)[Symbol.asyncIterator]();
    await it.next();
    await it.return(undefined);
    expect(frames[0].closed).toBe(true);
    expect(state).toEqual({ holds: 0, released: 1 });
    expect(anim.readFrame).toHaveBeenCalledTimes(1);
  });

  it('samples frames spread across the trim range and closes each', async () => {
    const { anim, frames } = fakeAnimation(new Array(40).fill(50));
    const samples = await collect(animationSamples(anim, { startSec: 0.5, endSec: 1.5 }, 4));
    expect(samples).toHaveLength(4);
    expect(frames.map((f) => f.index)).toEqual([12, 17, 22, 27]);
    expect(frames.every((f) => f.closed)).toBe(true);
  });
});

describe('framesAtTimes (video → GIF resampling)', () => {
  it('shows, at each output time, the last frame that started by then', async () => {
    const out = await collect(framesAtTimes(stream([0, 0.04, 0.08, 0.12, 0.16]), [0, 0.05, 0.1, 0.15]));
    expect(out.map(([f, t]) => [f.timestamp, t])).toEqual([
      [0, 0],
      [0.04, 0.05],
      [0.08, 0.1],
      [0.12, 0.15],
    ]);
  });

  it('holds the first frame before it starts and the last frame after the stream ends (no truncation)', async () => {
    const out = await collect(framesAtTimes(stream([0.1, 0.2]), [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]));
    expect(out.map(([f]) => f.timestamp)).toEqual([0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2]);
  });

  it('skips frames between output times on dense or variable-rate sources', async () => {
    const source = [0, 0.008, 0.025, 0.033, 0.058, 0.066, 0.075, 0.1, 0.133];
    const out = await collect(framesAtTimes(stream(source), [0, 0.04, 0.08, 0.12]));
    expect(out.map(([f]) => f.timestamp)).toEqual([0, 0.033, 0.075, 0.1]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(framesAtTimes(stream([]), [0, 0.1]))).toEqual([]);
  });
});

describe('spreadTimes', () => {
  it('puts samples at the centres of equal slices of the trim range', () => {
    expect(spreadTimes(4, {}, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(spreadTimes(10, { startSec: 2, endSec: 4 }, 2)).toEqual([2.5, 3.5]);
    expect(spreadTimes(4, { startSec: 3, endSec: 3 }, 8)).toEqual([]);
  });
});
