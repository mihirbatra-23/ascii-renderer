import { describe, expect, it } from 'vitest';
import { FrameCache, frameCacheCapacity, FRAME_CACHE_BUDGET_BYTES } from '../../src/media/frame-cache';

function setup(capacity: number) {
  const released: string[] = [];
  const produced: number[] = [];
  const cache = new FrameCache<string>(capacity, (v) => released.push(v));
  const produce = async (i: number) => {
    produced.push(i);
    return `frame${i}`;
  };
  return { cache, released, produced, produce };
}

describe('FrameCache', () => {
  it('evicts the least recently used frame and releases it', async () => {
    const { cache, released, produce } = setup(2);
    await cache.get(0, produce);
    await cache.get(1, produce);
    await cache.get(0, produce); // touch 0 → 1 is now least recent
    await cache.get(2, produce);
    expect(released).toEqual(['frame1']);
    expect(cache.size).toBe(2);
  });

  it('produces each frame once, even for concurrent requests', async () => {
    const { cache, produced, produce } = setup(4);
    const [a, b] = await Promise.all([cache.get(5, produce), cache.get(5, produce)]);
    expect(a).toBe('frame5');
    expect(b).toBe('frame5');
    await cache.get(5, produce);
    expect(produced).toEqual([5]);
  });

  it('does not cache failures', async () => {
    const { cache } = setup(2);
    let calls = 0;
    const flaky = async (i: number) => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return `frame${i}`;
    };
    await expect(cache.get(0, flaky)).rejects.toThrow('boom');
    await expect(cache.get(0, flaky)).resolves.toBe('frame0');
  });

  it('dispose releases everything and releases frames that finish afterwards', async () => {
    const { cache, released } = setup(4);
    await cache.get(0, async () => 'a');
    let finish!: (v: string) => void;
    const pending = cache.get(1, () => new Promise<string>((r) => (finish = r)));
    cache.dispose();
    expect(released).toEqual(['a']);
    finish('late');
    await expect(pending).rejects.toThrow();
    expect(released).toEqual(['a', 'late']);
    await expect(cache.get(2, async () => 'x')).rejects.toThrow();
  });

  it('sizes capacity from the memory budget with a floor', () => {
    expect(frameCacheCapacity(160 * 120 * 4)).toBe(Math.floor(FRAME_CACHE_BUDGET_BYTES / (160 * 120 * 4)));
    expect(frameCacheCapacity(8000 * 8000 * 4)).toBe(3);
  });
});
