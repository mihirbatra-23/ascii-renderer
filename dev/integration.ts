/**
 * Integration harness (dev only): the REAL engine, media and export modules wired end to end with
 * no UI, in the order the app has to call them. tests/e2e/integration.spec.ts drives it through
 * `window.integrationHarness`.
 *
 *   media   = await loadMedia(file)
 *   engine  = await createEngine()                       one per app; check engine.backend
 *   await engine.setParams(params)                       before anything that needs geometry
 *   engine.setLevels(measureFrameLevels(await sampleFramesForLevels(media)))   once per media
 *   engine.setSource(frame, info)                        stills: media.bitmap; animations and
 *                                                        video: every Player.onFrame frame
 *   engine.render(viewport) / engine.snapshot() / export*(engine | snapshot, ...)
 *   after an animated export: engine.resetHistory(); await player.seek(player.currentTime)
 */
import { decompressFrames, parseGIF } from 'gifuct-js';
import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';
import {
  createEngine,
  DEFAULT_PARAMS,
  measureFrameLevels,
  type EngineBackend,
  type GridSize,
  type Levels,
  type RenderParams,
  type RendererEngine,
  type SourceInfo,
  type Viewport,
} from '../src/engine';
import { createPlayer, loadMedia, sampleFramesForLevels, type LoadedAnimation, type LoadedMedia, type LoadedVideo, type Player } from '../src/media';
import {
  animationFrames,
  animationSamples,
  videoFrames,
  estimateExport,
  evenSize,
  exportGif,
  exportHtml,
  exportPng,
  exportSvg,
  exportTxt,
  exportVideo,
  gifRepeatCount,
  snapshotRows,
  snapshotToText,
  type ExportOptions,
  type ExportProgress,
} from '../src/export';
import { writeGif } from '../tests/media/helpers/gif-writer';

const stage = document.getElementById('stage')!;
const log = document.getElementById('log')!;

function viewport(): Viewport {
  return { width: 960, height: 540, devicePixelRatio: 1, zoom: 'fit', panX: 0, panY: 0, compare: null, showSource: false };
}

// ---------------------------------------------------------------------------------------------
// The wiring under test

async function fetchMedia(url: string): Promise<LoadedMedia> {
  const blob = await (await fetch(url)).blob();
  return loadMedia(blob, url.split('/').pop());
}

async function startEngine(backend: EngineBackend, params: Partial<RenderParams>): Promise<RendererEngine> {
  const engine = await createEngine({ backend });
  stage.replaceChildren(engine.canvas);
  await engine.setParams({ ...DEFAULT_PARAMS, ...params });
  return engine;
}

/** Auto-levels once per media (docs/ALGORITHM.md §3), from frames spread across it. */
async function applyLevels(engine: RendererEngine, media: LoadedMedia): Promise<Levels> {
  const levels = measureFrameLevels(await sampleFramesForLevels(media));
  engine.setLevels(levels);
  return levels;
}

function sourceInfo(media: LoadedMedia): SourceInfo {
  return { width: media.width, height: media.height, animated: media.kind !== 'image' };
}

/** A player whose frames go straight to the engine, as the app's controller does. */
function attachPlayer(engine: RendererEngine, media: LoadedAnimation | LoadedVideo): { player: Player; emitted: () => number } {
  const player = createPlayer(media);
  const info = sourceInfo(media);
  let emitted = 0;
  player.onFrame((frame) => {
    engine.setSource(frame, info);
    emitted++;
  });
  return { player, emitted: () => emitted };
}

// ---------------------------------------------------------------------------------------------
// Independent checks (nothing here reuses the engine's or exporters' own size code)

/** §1: rows = max(1, round(cols · H / W · cellW / cellH)). */
function formulaGrid(cols: number, width: number, height: number, cellW: number, cellH: number): GridSize {
  return { cols, rows: Math.max(1, Math.round(((cols * height) / width) * (cellW / cellH))) };
}

function formulaRaster(grid: GridSize, cellW: number, cellH: number, scale: number, margin: number) {
  return { width: (grid.cols * cellW + 2 * margin) * scale, height: (grid.rows * cellH + 2 * margin) * scale };
}

/** Luma spread of a drawable (0 for a blank canvas). Reads a WebGL canvas within the task that drew it. */
function lumaStd(source: CanvasImageSource, width: number, height: number): number {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  let sum = 0;
  let sq = 0;
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l;
    sq += l * l;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

async function decodeImage(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const result = { width: bitmap.width, height: bitmap.height, lumaStd: lumaStd(bitmap, bitmap.width, bitmap.height) };
  bitmap.close();
  return result;
}

function parseSvg(text: string) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  return {
    wellFormed: !doc.querySelector('parsererror') && root.localName === 'svg' && root.namespaceURI === 'http://www.w3.org/2000/svg',
    width: root.getAttribute('width'),
    height: root.getAttribute('height'),
    viewBox: root.getAttribute('viewBox'),
    shapes: root.querySelectorAll('path, circle, rect, polygon, line').length,
    texts: root.querySelectorAll('text').length,
  };
}

/** The text rows of an HTML export: the <pre>'s lines (glyph modes) or the shape page's selectable <text> rows. */
function parseHtmlRows(text: string): string[] | null {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const pre = doc.querySelector('pre');
  if (pre) return (pre.textContent ?? '').split('\n');
  const rows = [...doc.querySelectorAll('svg text')].map((t) => t.textContent ?? '');
  return rows.length ? rows : null;
}

/** NETSCAPE repeat count of a GIF, or -1 without the extension (play once). */
function netscapeLoop(bytes: Uint8Array): number {
  const id = new TextEncoder().encode('NETSCAPE2.0');
  outer: for (let i = 0; i + id.length + 4 < bytes.length; i++) {
    for (let k = 0; k < id.length; k++) if (bytes[i + k] !== id[k]) continue outer;
    return bytes[i + id.length + 2] | (bytes[i + id.length + 3] << 8);
  }
  return -1;
}

async function decodeGif(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const parsed = parseGIF(buffer);
  const frames = decompressFrames(parsed, true);
  return {
    count: frames.length,
    width: parsed.lsd.width,
    height: parsed.lsd.height,
    delays: frames.map((f) => f.delay),
    loop: netscapeLoop(new Uint8Array(buffer)),
  };
}

async function probeVideo(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const timestamps: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      timestamps.push(packet.timestamp);
    }
    const first = await track.getFirstTimestamp();
    // Chrome's hardware VP9 decoder on macOS returns the alpha plane in limited range (0 → 16);
    // the software decoder (and other players) return the encoded value.
    const sink = new CanvasSink(track, { alpha: true, decoderOptions: { hardwareAcceleration: 'prefer-software' } });
    const firstCanvas = (await sink.getCanvas(first))?.canvas;
    const corner = firstCanvas
      ? (firstCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D).getImageData(0, 0, 1, 1).data
      : null;
    return {
      codec: track.codec,
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await track.computeDuration(),
      firstTimestamp: first,
      packets: timestamps.length,
      cornerAlpha: corner ? corner[3] : null,
      hasAudio: (await input.getAudioTracks()).length > 0,
    };
  } finally {
    input.dispose();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Main-thread health while `work` runs: long tasks (PerformanceObserver) and rAF gaps. */
async function measureMainThread<T>(work: () => Promise<T>) {
  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ type: 'longtask' });
  const gaps: number[] = [];
  let running = true;
  let prev = 0;
  const tick = (t: number) => {
    if (!running) return;
    if (prev) gaps.push(t - prev);
    prev = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const started = performance.now();
  try {
    const result = await work();
    return { result, ...mainThreadStats(performance.now() - started, longTasks, gaps) };
  } finally {
    running = false;
    // Long-task entries are delivered asynchronously; let the last ones arrive.
    await sleep(50);
    observer.disconnect();
  }
}

function mainThreadStats(wallMs: number, longTasks: number[], gaps: number[]) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  const longSum = longTasks.reduce((a, b) => a + b, 0);
  return {
    wallMs: Math.round(wallMs),
    longTasks: { count: longTasks.length, totalMs: Math.round(longSum), maxMs: Math.round(Math.max(0, ...longTasks)) },
    blockedPct: Math.round((100 * longSum) / wallMs),
    rafGapMs: { p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0) },
  };
}

// ---------------------------------------------------------------------------------------------
// Scenarios

interface StillSpec {
  url: string;
  backend?: EngineBackend;
  params?: Partial<RenderParams>;
  scale: number;
  margin: number;
}

interface AnimatedSpec {
  url: string;
  params?: Partial<RenderParams>;
  scale: number;
  margin: number;
}

const harness = {
  /** Still: load → engine → levels → source → render → PNG / TXT / SVG / HTML. */
  async still(spec: StillSpec) {
    const media = await fetchMedia(spec.url);
    if (media.kind !== 'image') throw new Error(`${spec.url} is not a still`);
    const engine = await startEngine(spec.backend ?? 'webgl2', spec.params ?? {});
    try {
      const levels = await applyLevels(engine, media);
      engine.setSource(media.bitmap, sourceInfo(media));
      const stats = engine.render(viewport());
      const previewStd = lumaStd(engine.canvas, engine.canvas.width, engine.canvas.height);
      const { cellW, cellH } = engine.getGeometry();
      const grid = engine.getGrid();
      const snapshot = engine.snapshot();

      const png = await exportPng(engine, { scale: spec.scale, margin: spec.margin, transparentBackground: false, sourceName: media.name });
      const lines = snapshotToText(snapshot, '\n').split('\n');
      const finalLine = lines.pop();
      const txt = exportTxt(snapshot, { lineEnding: '\r\n', sourceName: media.name });
      const crlfLines = (await txt.blob.text()).split('\r\n').slice(0, -1);
      const svgOutlines = await exportSvg(snapshot, { margin: spec.margin, transparentBackground: false, svgText: 'outlines', sourceName: media.name });
      const svgText = await exportSvg(snapshot, { margin: spec.margin, transparentBackground: true, svgText: 'text', sourceName: media.name });
      const html = await exportHtml(snapshot, { margin: spec.margin, sourceName: media.name });

      // Exporting must leave the still's preview state untouched.
      engine.render(viewport());
      const after = engine.snapshot();
      return {
        backend: engine.backend,
        media: { width: media.width, height: media.height, kind: media.kind },
        levels,
        stats: { cols: stats.cols, rows: stats.rows },
        previewStd,
        grid,
        expectedGrid: formulaGrid(snapshot.params.columns, media.width, media.height, cellW, cellH),
        snapshotGrid: { cols: snapshot.cols, rows: snapshot.rows, cells: snapshot.chars.length },
        inkedCells: snapshot.chars.filter((c) => c !== ' ' && c !== '⠀').length,
        png: {
          declared: { width: png.width, height: png.height },
          decoded: await decodeImage(png.blob),
          expected: formulaRaster(grid, cellW, cellH, spec.scale, spec.margin),
          fileName: png.fileName,
          warnings: png.warnings,
        },
        txt: {
          rows: lines.length,
          finalLine,
          lengths: [...new Set(lines.map((l) => [...l].length))],
          crlfRows: crlfLines.length,
          sameAsSnapshot: lines.join('') === snapshotRows(snapshot).join(''),
          charsMatch: snapshot.params.mode === 'halftone' || lines.join('') === snapshot.chars.join(''),
        },
        svg: {
          outlines: { ...parseSvg(await svgOutlines.blob.text()), warnings: svgOutlines.warnings },
          text: { ...parseSvg(await svgText.blob.text()), warnings: svgText.warnings },
          expected: formulaRaster(grid, cellW, cellH, 1, spec.margin),
        },
        html: {
          rows: parseHtmlRows(await html.blob.text()),
          expectedRows: snapshotRows(snapshot),
          size: { width: html.width, height: html.height },
          expectedSize: formulaRaster(grid, cellW, cellH, 1, spec.margin),
          warnings: html.warnings,
        },
        unchangedAfterExport: after.chars.join('') === snapshot.chars.join('') && after.tone.every((t, i) => t === snapshot.tone[i]),
      };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /** Animation: player → engine, then GIF export with the source's delays and loop count. */
  async gif(spec: AnimatedSpec) {
    const media = await fetchMedia(spec.url);
    if (media.kind !== 'animation') throw new Error(`${spec.url} is not an animation`);
    const engine = await startEngine('webgl2', spec.params ?? {});
    const { player, emitted } = attachPlayer(engine, media);
    try {
      await applyLevels(engine, media);
      await player.seek(0);
      engine.render(viewport());
      const first = engine.snapshot().chars.join('');
      await player.step(1);
      engine.render(viewport());
      const second = engine.snapshot().chars.join('');
      const beforePlay = emitted();
      player.play();
      await sleep(400);
      player.pause();
      const played = emitted() - beforePlay;

      const progress: ExportProgress[] = [];
      const colour = (spec.params?.colorMode ?? DEFAULT_PARAMS.colorMode) === 'source';
      const result = await exportGif(
        engine,
        animationFrames(media),
        {
          scale: spec.scale,
          margin: spec.margin,
          loopCount: gifRepeatCount(media.loopCount),
          frameCount: media.frameCount,
          paletteSamples: colour ? animationSamples(media) : undefined,
          sourceName: media.name,
        },
        (p) => progress.push(p),
      );
      const { cellW, cellH } = engine.getGeometry();

      // What the UI does after an animated export: forget history, put the current frame back.
      engine.resetHistory();
      await player.seek(0);
      engine.render(viewport());
      const restored = engine.snapshot().chars.join('');
      return {
        media: { frameCount: media.frameCount, durations: media.durations, loopCount: media.loopCount, hasAlpha: media.hasAlpha },
        stepChangesGrid: first !== second,
        played,
        grid: engine.getGrid(),
        expected: formulaRaster(engine.getGrid(), cellW, cellH, spec.scale, spec.margin),
        result: { width: result.width, height: result.height, fileName: result.fileName, warnings: result.warnings, size: result.blob.size },
        decoded: await decodeGif(result.blob),
        lastProgress: progress.at(-1)?.label ?? null,
        restoredMatchesFirst: restored === first,
      };
    } finally {
      player.dispose();
      engine.dispose();
      media.dispose();
    }
  },

  /** A synthetic GIF with NETSCAPE `loop` (undefined = no extension) through loadMedia → exportGif. */
  async gifLoop(loop: number | undefined) {
    const indices = (phase: number) => Array.from({ length: 32 * 16 }, (_, i) => ((i % 32) + phase) % 8 < 4 ? 1 : 0);
    const bytes = writeGif({
      width: 32,
      height: 16,
      globalPalette: [
        [0, 0, 0],
        [255, 255, 255],
      ],
      loop,
      frames: [
        { width: 32, height: 16, indices: indices(0), delayCs: 10 },
        { width: 32, height: 16, indices: indices(4), delayCs: 20 },
      ],
    });
    const media = await loadMedia(new Blob([bytes], { type: 'image/gif' }), 'loop.gif');
    if (media.kind !== 'animation') throw new Error('expected an animation');
    const engine = await startEngine('webgl2', { columns: 20 });
    try {
      const result = await exportGif(engine, animationFrames(media), { scale: 1, margin: 0, loopCount: gifRepeatCount(media.loopCount), frameCount: media.frameCount });
      return { sourcePlays: media.loopCount, decoded: await decodeGif(result.blob) };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /** Video: player → engine, then MP4 / WebM export through Mediabunny (frame-exact, source timing). */
  async video(spec: AnimatedSpec & { format: 'mp4' | 'webm' }) {
    const media = await fetchMedia(spec.url);
    if (media.kind !== 'video') throw new Error(`${spec.url} is not a video`);
    const engine = await startEngine('webgl2', spec.params ?? {});
    const { player, emitted } = attachPlayer(engine, media);
    try {
      await applyLevels(engine, media);
      const playheadAfterLevels = player.currentTime;
      await player.seek(0);
      engine.render(viewport());
      const atStart = engine.snapshot().chars.join('');
      await player.seek(2);
      engine.render(viewport());
      const atTwo = engine.snapshot().chars.join('');

      // Real-time playback: render on every presented frame, as the app's render loop does.
      const beforePlay = emitted();
      let renders = 0;
      let rendering = true;
      const loop = () => {
        if (!rendering) return;
        if (engine.render(viewport()).cols > 0) renders++;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      player.play();
      await sleep(600);
      player.pause();
      rendering = false;
      const played = emitted() - beforePlay;

      const { cellW, cellH } = engine.getGeometry();
      const grid = engine.getGrid();
      const progress: ExportProgress[] = [];
      const result = await exportVideo(
        engine,
        media,
        {
          format: spec.format,
          scale: spec.scale,
          margin: spec.margin,
          transparentBackground: false,
          includeAudio: true,
          sourceName: media.name,
        },
        (p) => progress.push(p),
      );

      engine.resetHistory();
      await player.seek(0);
      engine.render(viewport());
      const restored = engine.snapshot().chars.join('');
      return {
        media: { width: media.width, height: media.height, durationSec: media.durationSec, fps: media.fps, canDecodeFrames: media.canDecodeFrames ?? null },
        playheadAfterLevels,
        seekChangesGrid: atStart !== atTwo,
        played,
        renders,
        grid,
        expected: evenSize(formulaRaster(grid, cellW, cellH, spec.scale, spec.margin)),
        result: { width: result.width, height: result.height, fileName: result.fileName, warnings: result.warnings, size: result.blob.size },
        probe: await probeVideo(result.blob),
        lastProgress: progress.at(-1)?.label ?? null,
        restoredMatchesStart: restored === atStart,
      };
    } finally {
      player.dispose();
      engine.dispose();
      media.dispose();
    }
  },

  /**
   * A video WebCodecs cannot decode (simulated: canDecodeFrames false, as media reports for such
   * files) is recorded from its own <video> element in real time instead of failing.
   */
  async undecodableVideo(spec: AnimatedSpec & { endSec: number }) {
    const loaded = await fetchMedia(spec.url);
    if (loaded.kind !== 'video') throw new Error(`${spec.url} is not a video`);
    const media: LoadedVideo = { ...loaded, canDecodeFrames: false };
    const engine = await startEngine('webgl2', spec.params ?? {});
    try {
      await applyLevels(engine, media);
      const { cellW, cellH } = engine.getGeometry();
      engine.setSource(media.element, sourceInfo(media));
      const grid = engine.getGrid();
      const options: ExportOptions = {
        format: 'webm',
        scale: spec.scale,
        margin: spec.margin,
        transparentBackground: false,
        lineEnding: '\n',
        svgText: 'outlines',
        includeAudio: false,
      };
      const estimates = {
        webm: await estimateExport(engine, media, options),
        gif: await estimateExport(engine, media, { ...options, format: 'gif' }),
      };
      const started = performance.now();
      const result = await exportVideo(engine, media, {
        format: 'webm',
        scale: spec.scale,
        margin: spec.margin,
        transparentBackground: false,
        includeAudio: false,
        startSec: 0,
        endSec: spec.endSec,
        sourceName: media.name,
      });
      return {
        wallSec: (performance.now() - started) / 1000,
        expected: evenSize(formulaRaster(grid, cellW, cellH, spec.scale, spec.margin)),
        result: { width: result.width, height: result.height, fileName: result.fileName, warnings: result.warnings, type: result.blob.type },
        probe: await probeVideo(result.blob),
        estimates,
        elementRestored: { time: media.element.currentTime, paused: media.element.paused, muted: media.element.muted },
      };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /**
   * WebGL context loss and restore while the engine's source is a frame that has since been closed
   * (as the animation frame cache does on eviction): no uncaught error, and the next frame renders.
   */
  async contextRestoreWithClosedFrame() {
    const media = await fetchMedia('/tests/fixtures/transparent_variable_duration.gif');
    if (media.kind !== 'animation') throw new Error('expected an animation');
    const engine = await startEngine('webgl2', { columns: 60 });
    try {
      const info = sourceInfo(media);
      const evicted = await createImageBitmap(await media.getFrame(0));
      engine.setSource(evicted, info);
      engine.render(viewport());
      evicted.close();
      const gl = engine.canvas.getContext('webgl2')!;
      const lose = gl.getExtension('WEBGL_lose_context')!;
      const restored = new Promise<void>((resolve) => engine.canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true }));
      lose.loseContext();
      await sleep(50);
      lose.restoreContext();
      await restored;
      await sleep(0);
      engine.render(viewport()); // nothing to show yet: must not throw
      engine.setSource(await media.getFrame(1), info);
      const stats = engine.render(viewport());
      return { after: { cols: stats.cols, rows: stats.rows }, inked: engine.snapshot().chars.some((c) => c !== ' ') };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /**
   * Frames with no pixels (a <video> before its first frame, a closed ImageBitmap) must not make
   * render() throw on either backend (the app's render loop runs before media is ready).
   */
  async framesWithoutPixels(backend: EngineBackend) {
    const engine = await startEngine(backend, { columns: 40 });
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    try {
      const info: SourceInfo = { width: 64, height: 32, animated: true };
      const closed = await createImageBitmap(new ImageData(new Uint8ClampedArray(64 * 32 * 4).fill(200), 64, 32));
      closed.close();
      engine.setSource(closed, info);
      const closedRender = attempt(() => engine.render(viewport()));
      const closedSnapshot = attempt(() => engine.snapshot());
      engine.setSource(document.createElement('video'), info);
      const videoRender = attempt(() => engine.render(viewport()));
      return { backend: engine.backend, closedRender, closedSnapshot, videoRender };
    } finally {
      engine.dispose();
    }
  },

  /**
   * Main-thread cost of an export with the real engine (no UI): long tasks and rAF gaps while it
   * runs, and how long Cancel takes when `cancelAfterMs` is set. Keeps exports from blocking the
   * editor: video → MP4 / WebM / GIF, or a PNG of the first frame.
   */
  async exportJank(spec: AnimatedSpec & { format: 'mp4' | 'webm' | 'gif' | 'png'; cancelAfterMs?: number }) {
    const media = await fetchMedia(spec.url);
    if (media.kind === 'image') throw new Error(`${spec.url} is a still`);
    const engine = await startEngine('webgl2', spec.params ?? {});
    const controller = new AbortController();
    let cancelledAt = 0;
    if (spec.cancelAfterMs !== undefined) {
      setTimeout(() => {
        cancelledAt = performance.now();
        controller.abort();
      }, spec.cancelAfterMs);
    }
    try {
      await applyLevels(engine, media);
      engine.setSource(media.kind === 'video' ? media.element : await media.getFrame(0), sourceInfo(media));
      engine.render(viewport());
      const base = { scale: spec.scale, margin: spec.margin, sourceName: media.name };
      const run = async () => {
        if (spec.format === 'png') return exportPng(engine, { ...base, transparentBackground: false }, controller.signal);
        if (spec.format === 'gif') {
          const frames = media.kind === 'video' ? videoFrames(media, { fps: 25 }) : animationFrames(media);
          return exportGif(engine, frames, base, undefined, controller.signal);
        }
        const input = media.kind === 'video' ? media : { kind: 'frames' as const, frames: animationFrames(media), frameCount: media.frameCount };
        return exportVideo(engine, input, { ...base, format: spec.format, transparentBackground: false, includeAudio: false }, undefined, controller.signal);
      };
      let settledAt = 0;
      const measured = await measureMainThread(async () => {
        try {
          return await run();
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
          return null;
        } finally {
          settledAt = performance.now();
        }
      });
      const { result, ...stats } = measured;
      return {
        ...stats,
        outcome: result ? 'done' : 'cancelled',
        cancelMs: result ? null : Math.round(settledAt - cancelledAt),
        size: result ? { width: result.width, height: result.height } : null,
        frames: result && spec.format !== 'png' && spec.format !== 'gif' ? (await probeVideo(result.blob)).packets : null,
        gifFrames: result && spec.format === 'gif' ? (await decodeGif(result.blob)).count : null,
      };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /**
   * A PNG export started just before the params change: the file name must describe the
   * grid in the pixels, both from the render that the export itself started.
   */
  async pngNameMatchesPixels() {
    const media = await fetchMedia('/tests/fixtures/terrain_640x360.png');
    if (media.kind !== 'image') throw new Error('expected a still');
    const engine = await startEngine('webgl2', { columns: 120 });
    try {
      engine.setSource(media.bitmap, sourceInfo(media));
      const { cellW, cellH } = engine.getGeometry();
      const pending = exportPng(engine, { scale: 1, margin: 0, transparentBackground: false, sourceName: media.name });
      // The user drags Columns while the PNG is being read back and encoded.
      await engine.setParams({ ...DEFAULT_PARAMS, columns: 90 });
      const png = await pending;
      const decoded = await decodeImage(png.blob);
      return { fileName: png.fileName, pixelsGrid: { cols: decoded.width / cellW, rows: decoded.height / cellH }, gridNow: engine.getGrid() };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /** PNG at an exact width with the real engine: the exact size, and the same picture as the 2× raster. */
  async pngTargetWidth(targetWidth: number) {
    const media = await fetchMedia('/tests/fixtures/torus_450.png');
    if (media.kind !== 'image') throw new Error('expected a still');
    const engine = await startEngine('webgl2', { columns: 100 });
    try {
      engine.setSource(media.bitmap, sourceInfo(media));
      const png = await exportPng(engine, { scale: 1, targetWidth, margin: 0, transparentBackground: false, sourceName: media.name });
      const { cellW, cellH } = engine.getGeometry();
      const grid = engine.getGrid();
      return {
        decoded: await decodeImage(png.blob),
        declared: { width: png.width, height: png.height },
        base: formulaRaster(grid, cellW, cellH, 1, 0),
      };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },

  /** Animation → transparent WebM: the FrameSequence path of exportVideo with the real engine. */
  async animationToVideo(spec: AnimatedSpec) {
    const media = await fetchMedia(spec.url);
    if (media.kind !== 'animation') throw new Error(`${spec.url} is not an animation`);
    const engine = await startEngine('webgl2', spec.params ?? {});
    try {
      await applyLevels(engine, media);
      const { cellW, cellH } = engine.getGeometry();
      engine.setSource(await media.getFrame(0), sourceInfo(media));
      const grid = engine.getGrid();
      const result = await exportVideo(
        engine,
        { kind: 'frames', frames: animationFrames(media), frameCount: media.frameCount },
        { format: 'webm', scale: spec.scale, margin: spec.margin, transparentBackground: true, includeAudio: false, sourceName: media.name },
      );
      return {
        totalSec: media.totalMs / 1000,
        frameCount: media.frameCount,
        expected: evenSize(formulaRaster(grid, cellW, cellH, spec.scale, spec.margin)),
        result: { width: result.width, height: result.height, fileName: result.fileName, warnings: result.warnings },
        probe: await probeVideo(result.blob),
      };
    } finally {
      engine.dispose();
      media.dispose();
    }
  },
};

declare global {
  interface Window {
    integrationHarness: typeof harness;
  }
}
window.integrationHarness = harness;
log.textContent = 'harness ready';
