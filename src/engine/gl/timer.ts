/**
 * GPU time of rendered frames via EXT_disjoint_timer_query_webgl2. A TIME_ELAPSED query wraps each
 * frame's passes; results arrive a few frames later and are collected without ever waiting.
 * Without the extension (Safari, Firefox by default) the GPU time is simply unknown.
 *
 * Only frames that ran the analysis (passes 1–2) are reported: a compose-only redraw (a pan, a
 * layout settle) costs a fraction of a frame and would otherwise replace the analysed frame's time
 * whenever both finish between two reads.
 *
 * Public API
 *   GpuTimer(gl)
 *     begin(analysed) / end()  bracket one frame's GL work (nested or overlapping frames are skipped);
 *                              `analysed` says whether the frame ran passes 1–2
 *     latestMs                 GPU ms of the most recent analysed frame whose result has arrived, or null
 *     drain()                  → GPU ms of every analysed frame finished since the last drain, oldest first
 *     dispose()
 */
import type { GL } from './gl';

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface Pending {
  query: WebGLQuery;
  analysed: boolean;
}

/** At most this many results may be outstanding; frames beyond it are not timed. */
const MAX_PENDING = 4;
/** Finished results kept until drained (a reader that stops draining does not grow memory). */
const MAX_FINISHED = 64;

export class GpuTimer {
  private readonly ext: TimerQueryExt | null;
  private pending: Pending[] = [];
  private active: Pending | null = null;
  private finished: number[] = [];
  latestMs: number | null = null;

  constructor(private readonly gl: GL) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  begin(analysed: boolean): void {
    const { gl, ext } = this;
    this.collect();
    if (!ext || this.active || this.pending.length >= MAX_PENDING) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = { query, analysed };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Reads every finished query; a disjoint event (clock change, GPU reset) invalidates them all. */
  collect(): void {
    const { gl, ext } = this;
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const { query, analysed } = this.pending[0];
      if (!disjoint && !(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
      if (!disjoint && analysed) {
        const ms = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
        this.latestMs = ms;
        this.finished.push(ms);
        if (this.finished.length > MAX_FINISHED) this.finished.shift();
      }
      gl.deleteQuery(query);
      this.pending.shift();
    }
  }

  drain(): number[] {
    this.collect();
    const out = this.finished;
    this.finished = [];
    return out;
  }

  dispose(): void {
    for (const { query } of this.pending) this.gl.deleteQuery(query);
    if (this.active) this.gl.deleteQuery(this.active.query);
    this.pending = [];
    this.active = null;
    this.finished = [];
  }
}
