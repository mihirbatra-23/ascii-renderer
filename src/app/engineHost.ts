/**
 * The engine's lifecycle and the preview render loop, kept outside React.
 *
 *   ensureEngine()          → Promise<RendererEngine>; created once, lazily, then kept in runtime.engine
 *   prepareEngineWhenIdle() creates it ahead of the first open, in idle time
 *   requestRender()         one draw on the next animation frame (repeat calls coalesce); the engine
 *                           re-runs only what changed (source frame, params, levels, or just the view)
 *   setStageBox(box)        the preview's measured size (Stage's ResizeObserver)
 *   useStageLayout()        where the last draw put the grid, for the DOM overlays
 *   getStageLayout()        the same, outside React (pointer handlers)
 *   onDraw(fn)              called after every draw (the probe re-reads the cell under the pointer)
 *   probeCell(col, row)     one cell of the last analysed grid (engine.probe: no GPU readback)
 *
 * Nothing renders on an idle animation frame: a draw happens only after a request (params, view,
 * source frame, resize). The engine is created during start-screen idle time and compiles every
 * mode's programs in the background from then on, so neither the first picture nor the first switch
 * to another mode stalls on a compile. Stats reach the store at most four times a second.
 */
import { useSyncExternalStore } from 'react';
import { createEngine, type CellProbe, type RendererEngine } from '../engine';
import { useStore, type ViewState } from '../state/store';
import { selectTransparentPreview } from '../ui/export/transparency';
import { effectiveCompare } from '../ui/stage/compare';
import { computeLayout, sameLayout, type StageBox, type StageLayout } from '../ui/stage/layout';
import { toast } from '../ui/kit';
import { runtime } from './runtime';

// ---------------------------------------------------------------- engine

let enginePromise: Promise<RendererEngine> | null = null;

export function ensureEngine(): Promise<RendererEngine> {
  // A failed attempt is forgotten, so the next open tries again.
  enginePromise ??= startEngine().catch((e: unknown) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

async function startEngine(): Promise<RendererEngine> {
  const engine = await createEngine();
  // Following first: a change made while the first setParams loads its font (the engine is created
  // while the start screen is in use) must still reach the engine; a newer setParams supersedes an
  // older one (EngineBase), so the order they finish in does not matter.
  const unfollow = followParams(engine);
  try {
    await engine.setParams(useStore.getState().params);
  } catch (e) {
    unfollow();
    engine.dispose();
    throw e;
  }
  useStore.getState().setStats({ gpu: engine.backend === 'webgl2' ? 'WebGL2' : 'CPU' });
  runtime.set({ engine });
  // Compiling starts now, while the first file is still decoding: with parallel shader compile the
  // first draw then finds its programs ready instead of compiling them in one long task.
  warmUp(engine);
  // The engine rebuilds its GPU state on restore; the picture comes back with the next draw.
  engine.canvas.addEventListener('webglcontextrestored', requestRender);
  return engine;
}

/** Every params change goes to the engine; glyph rebuilds happen only when font / charset / line height change (the engine decides). */
function followParams(engine: RendererEngine): () => void {
  return useStore.subscribe(
    (s) => s.params,
    (params) => {
      engine.setParams(params).then(requestRender, (e: unknown) => {
        toast({ kind: 'error', title: 'Couldn’t load the font', body: e instanceof Error ? e.message : String(e) });
      });
    },
  );
}

function warmUp(engine: RendererEngine): void {
  engine.warmup().catch(() => {
    // Only a head start: a program that failed to compile here compiles (or reports) on first use.
  });
}

/**
 * Creates the engine (and so starts compiling its programs) while the start screen is idle, so the
 * first open neither waits for a WebGL context nor compiles on the main thread. A failure here is
 * left for the open to report: ensureEngine forgets a failed attempt and tries again.
 */
export function prepareEngineWhenIdle(): void {
  const prepare = () => void ensureEngine().catch(() => undefined);
  if ('requestIdleCallback' in window) requestIdleCallback(prepare, { timeout: 2000 });
  else setTimeout(prepare, 200);
}

// ---------------------------------------------------------------- render loop

let frame = 0;
let box: StageBox | null = null;

export function requestRender(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

export function setStageBox(next: StageBox | null): void {
  box = next;
  requestRender();
}

function draw(): void {
  frame = 0;
  const engine = runtime.get().engine;
  if (!engine || !box) return publish(null);
  const grid = engine.getGrid();
  if (grid.cols === 0) return publish(null);
  const state = useStore.getState();
  const view = { ...state.view, compareWith: effectiveCompare(state.view, state.params) };
  const layout = computeLayout(box, grid, engine.getGeometry(), view, selectTransparentPreview(state));
  engine.render(layout.viewport);
  publish(layout);
  recordStats(engine, grid.cols, grid.rows);
  drawListeners.forEach((fn) => fn());
}

const drawListeners = new Set<() => void>();

export function onDraw(fn: () => void): () => void {
  drawListeners.add(fn);
  return () => drawListeners.delete(fn);
}

// The view drives only the compose pass; the probe is overlay state and never redraws the canvas.
useStore.subscribe(
  (s) => viewKey(s.view),
  () => requestRender(),
);
// Export's Transparent background shows in the preview as paper dropped over a checker.
useStore.subscribe(selectTransparentPreview, () => requestRender());

function viewKey(v: ViewState): string {
  return `${v.mode}|${v.split}|${v.compareWith}|${v.zoom}|${v.panX}|${v.panY}`;
}

// ---------------------------------------------------------------- layout for overlays

let layout: StageLayout | null = null;
const layoutListeners = new Set<() => void>();

function publish(next: StageLayout | null): void {
  if (sameLayout(layout, next)) return;
  layout = next;
  layoutListeners.forEach((fn) => fn());
}

export function getStageLayout(): StageLayout | null {
  return layout;
}

export function useStageLayout(): StageLayout | null {
  return useSyncExternalStore(
    (fn) => {
      layoutListeners.add(fn);
      return () => layoutListeners.delete(fn);
    },
    () => layout,
  );
}

// ---------------------------------------------------------------- stats

const STATS_INTERVAL_MS = 250;
const FPS_WINDOW_MS = 1000;
const MIN_FPS_FRAMES = 5;
/** Render time is a mean over this many recent frames, so one compile or upload does not stick. */
const TIMING_WINDOW = 20;
const frameTimes: number[] = [];
const timings: number[] = [];
/** True once the engine has reported a GPU time: from then on only GPU times are averaged. */
let gpuTimer = false;
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let grid = { cols: 0, rows: 0 };

function recordStats(engine: RendererEngine, cols: number, rows: number): void {
  frameTimes.push(performance.now());
  grid = { cols, rows };
  sampleTimings(engine, true);
  // The first draw after the editor opens is published at once, so Grid / Render never read "–" for a beat.
  statsTimer ??= setTimeout(flushStats, useStore.getState().stats.cols ? STATS_INTERVAL_MS : 0);
}

/**
 * GPU time (analysis and compose, from timer queries) when the browser has them, else the CPU
 * time of the draw. Query results arrive a few frames late, so they are also collected between
 * draws (`afterDraw` false): a still drawn once still gets its GPU time within the stats window.
 * Every analysed frame's result is averaged (several can finish between two samples); view-only
 * redraws are not timed into it, so a still at rest keeps showing what its picture costs.
 */
function sampleTimings(engine: RendererEngine, afterDraw: boolean): void {
  const { gpuMs, cpuMs, gpuSamples } = engine.getTimings();
  if (gpuMs !== null || gpuSamples?.length) {
    if (!gpuTimer) timings.length = 0;
    gpuTimer = true;
    for (const ms of gpuSamples ?? []) push(ms);
  } else if (!gpuTimer && afterDraw) {
    push(cpuMs);
  }
}

function push(ms: number): void {
  timings.push(ms);
  if (timings.length > TIMING_WINDOW) timings.shift();
}

/**
 * FPS is the draw rate over the last second while frames are flowing (playback, drags). A still
 * at rest, or a single redraw, reads 0 (shown as "–") rather than a stale or meaningless rate.
 */
function flushStats(): void {
  statsTimer = undefined;
  const engine = runtime.get().engine;
  if (engine) sampleTimings(engine, false);
  const now = performance.now();
  while (frameTimes.length && now - frameTimes[0] > FPS_WINDOW_MS) frameTimes.shift();
  const n = frameTimes.length;
  const fps = n >= MIN_FPS_FRAMES ? Math.round(((n - 1) * 1000) / (frameTimes[n - 1] - frameTimes[0])) : 0;
  const ms = timings.length ? timings.reduce((sum, t) => sum + t, 0) / timings.length : 0;
  useStore.getState().setStats({ ...grid, ms, timer: gpuTimer ? 'gpu' : 'cpu', fps: Math.min(fps, 240) });
  if (frameTimes.length) statsTimer = setTimeout(flushStats, STATS_INTERVAL_MS);
}

// ---------------------------------------------------------------- probe

/** The cell under the cursor (and its neighbours, for the tag's placement), without a GPU readback. */
export function probeCell(col: number, row: number): CellProbe | null {
  return runtime.get().engine?.probe(col, row) ?? null;
}
