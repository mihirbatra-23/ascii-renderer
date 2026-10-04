import { describe, expect, it } from 'vitest';
import type { LoadedVideo } from '../../src/media/types';
import { clipOf } from '../../src/ui/transport/clip';

const video = { kind: 'video', durationSec: 1, fps: 10 } as LoadedVideo;

/** The transport counts and snaps video frames by their real timestamps once the player knows them. */
describe('transport clip', () => {
  it('uses the average rate until timestamps are known', () => {
    const clip = clipOf(video);
    expect(clip.frameCount).toBe(10);
    expect(clip.frameAt(0.55)).toBe(5);
    expect(clip.frameTime(5)).toBeCloseTo(0.55);
  });

  it('follows variable frame timing', () => {
    // A burst of short frames, then long ones.
    const clip = clipOf(video, Float64Array.from([0, 0.05, 0.1, 0.15, 0.5]));
    expect(clip.frameCount).toBe(5);
    expect(clip.frameAt(0.12)).toBe(2);
    expect(clip.frameAt(0.49)).toBe(3);
    expect(clip.frameAt(0.9)).toBe(4);
    expect(clip.frameStart(4)).toBe(0.5);
    expect(clip.frameStart(5)).toBe(1);
    // Seeks aim mid-frame, so timestamp rounding cannot land on the previous frame.
    expect(clip.frameTime(3)).toBeCloseTo(0.325);
    expect(clip.frameAt(clip.frameTime(3))).toBe(3);
    expect(clip.frameTime(99)).toBeCloseTo(0.75);
  });
});
