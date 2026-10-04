import { describe, expect, it } from 'vitest';
import type { GL } from '../../src/engine/gl/gl';
import { GpuTimer } from '../../src/engine/gl/timer';

const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/** A WebGL2 context stand-in with EXT_disjoint_timer_query_webgl2 whose queries finish on demand. */
function fakeGl() {
  const results = new Map<object, number>();
  const queries: object[] = [];
  const gl = {
    QUERY_RESULT,
    QUERY_RESULT_AVAILABLE,
    getExtension: () => ({ TIME_ELAPSED_EXT, GPU_DISJOINT_EXT }),
    createQuery: () => {
      const q = {};
      queries.push(q);
      return q;
    },
    beginQuery: () => {},
    endQuery: () => {},
    deleteQuery: () => {},
    getParameter: () => false,
    getQueryParameter: (q: object, pname: number) => (pname === QUERY_RESULT_AVAILABLE ? results.has(q) : results.get(q)),
  };
  /** Finishes query `i` with a GPU time of `ms`. */
  const finish = (i: number, ms: number) => results.set(queries[i], ms * 1e6);
  return { gl: gl as unknown as GL, finish };
}

describe('GpuTimer', () => {
  // a still's analysed frame and a later view-only redraw finished between two reads, and
  // only the redraw's 0.3 ms survived, so the status bar showed a tenth of the frame's real cost.
  it('reports every analysed frame that finished, and not view-only redraws', () => {
    const { gl, finish } = fakeGl();
    const timer = new GpuTimer(gl);
    timer.begin(true);
    timer.end();
    timer.begin(true);
    timer.end();
    timer.begin(false);
    timer.end();
    finish(0, 4);
    finish(1, 6);
    finish(2, 0.3);
    expect(timer.drain()).toEqual([4, 6]);
    expect(timer.latestMs).toBe(6);
    expect(timer.drain()).toEqual([]);
  });

  it('keeps results in frame order and waits for an unfinished earlier frame', () => {
    const { gl, finish } = fakeGl();
    const timer = new GpuTimer(gl);
    timer.begin(true);
    timer.end();
    timer.begin(true);
    timer.end();
    finish(1, 5);
    expect(timer.drain()).toEqual([]);
    finish(0, 3);
    expect(timer.drain()).toEqual([3, 5]);
  });
});
