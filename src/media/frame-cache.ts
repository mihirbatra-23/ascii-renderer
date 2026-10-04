/** Least-recently-used cache of decoded frames, with concurrent requests for one frame deduplicated. */
import { CLOSED_MESSAGE } from './lifetime';

/** Decoded-frame memory per animation. Composited frames are cheap to rebuild, so this stays modest. */
export const FRAME_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;
/** Always keep a few frames so the frame on screen and its neighbours are never evicted mid-use. */
const MIN_ENTRIES = 3;

export function frameCacheCapacity(bytesPerFrame: number): number {
  return Math.max(MIN_ENTRIES, Math.floor(FRAME_CACHE_BUDGET_BYTES / Math.max(1, bytesPerFrame)));
}

export class FrameCache<T> {
  private readonly entries = new Map<number, T>();
  private readonly pending = new Map<number, Promise<T>>();
  private disposed = false;

  constructor(
    private readonly capacity: number,
    /** Releases an evicted value (e.g. ImageBitmap.close). */
    private readonly release: (value: T) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(index: number, produce: (index: number) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(CLOSED_MESSAGE));
    const hit = this.entries.get(index);
    if (hit !== undefined) {
      // Map iteration order is insertion order: re-inserting marks the entry most recently used.
      this.entries.delete(index);
      this.entries.set(index, hit);
      return Promise.resolve(hit);
    }
    const inFlight = this.pending.get(index);
    if (inFlight) return inFlight;

    const request = produce(index).then(
      (value) => {
        this.pending.delete(index);
        if (this.disposed) {
          this.release(value);
          throw new Error(CLOSED_MESSAGE);
        }
        this.entries.set(index, value);
        this.evictOverflow();
        return value;
      },
      (error: unknown) => {
        this.pending.delete(index);
        throw error;
      },
    );
    this.pending.set(index, request);
    return request;
  }

  dispose(): void {
    this.disposed = true;
    for (const value of this.entries.values()) this.release(value);
    this.entries.clear();
  }

  private evictOverflow(): void {
    for (const [index, value] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(index);
      this.release(value);
    }
  }
}
