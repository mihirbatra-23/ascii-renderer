/**
 * Runs an export with the real exporters (src/export) and reports through store.job.
 *
 * Stills render from the preview engine as it is now (for a clip, the frame at the playhead).
 * GIF and video render on a separate engine built from a snapshot of the settings, so the encode
 * is unaffected by edits ("Keep editing"). A live camera's MP4 / WebM is recorded in real time
 * until stopRecording(). One job at a time; cancelExport() aborts an encode or discards a recording.
 *
 * For the whole job the media is retained (opening or closing another file cannot dispose it
 * underneath the encoder), and during a GIF / video export the preview player is paused so it
 * does not compete with the encoder for the main thread and the GPU; it resumes afterwards.
 */
import { runtime } from '../../app/runtime';
import { createEngine, measureFrameLevels, type Levels, type RendererEngine, type RenderParams } from '../../engine';
import {
  animationFrames,
  animationSamples,
  copyPng,
  copySvg,
  copyText,
  exportGif,
  exportHtml,
  exportPng,
  exportSvg,
  exportTxt,
  exportVideo,
  gifFps,
  isAbortError,
  saveBlob,
  snapshotToText,
  startRecording,
  videoFrames,
  videoSamples,
  type ExportProgress,
  type ExportResult,
  type FrameInput,
  type LiveRecording,
  type PngExportOptions,
} from '../../export';
import type { ExportFormat, ExportOptions } from '../../export/types';
import { sampleFramesForLevels, type LoadedAnimation, type LoadedMedia, type LoadedVideo } from '../../media';
import { IDLE_JOB, useStore, type ExportUiState } from '../../state/store';
import { toast } from '../kit';
import { exportRange, motionFrameCount } from './frameCount';
import { canBeTransparent, FORMAT_LABEL, formatBytes, isMotion, planExport, ratioLabel, type EngineGeometry, type ExportPlan } from './sizing';

const store = () => useStore.getState();

let controller: AbortController | null = null;
let runningFormat: ExportFormat | null = null;
/** The media the last job exported; a failed job's Try again only makes sense for the same one. */
let jobMedia: LoadedMedia | undefined;

/** A live camera being recorded (the job is 'running' until it is stopped or discarded). */
interface Recording {
  live: LiveRecording;
  /** The settings it started with, for the file name and the saved toast. */
  ui: ExportUiState;
  plan: ExportPlan;
  /** Stops watching for the camera being closed and stops publishing the clock. */
  unwatch(): void;
}

/** How often the recording's clock and frame count reach the store (footer, status bar). */
const RECORDING_TICK_MS = 250;
let recording: Recording | null = null;

/** Cancels an encode, or discards a recording. */
export function cancelExport(): void {
  controller?.abort();
  if (recording) void discardRecording();
}

/** The recording in progress, if any (its clock and frame count are mirrored in store.job.recording). */
export function activeRecording(): LiveRecording | null {
  return recording?.live ?? null;
}

/** The format being exported right now (the panel's selection may change meanwhile). */
export function jobFormat(): ExportFormat | null {
  return runningFormat;
}

/** The media the last export ran on (Try again is offered only while it is still the open one). */
export function lastJobMedia(): LoadedMedia | undefined {
  return jobMedia;
}

/** Characters a file name cannot hold on common systems. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

function cleanBaseName(name: string): string {
  return name.replace(UNSAFE, '-').trim().replace(/[.\s]+$/, '');
}

/** The user's base name (if any) with the extension the exporter actually wrote. */
function finalName(written: string, userBase: string): string {
  const base = cleanBaseName(userBase);
  if (!base) return written;
  const ext = /\.[a-z0-9]+$/i.exec(written)?.[0] ?? '';
  return base + ext;
}

/** GIF NETSCAPE repeat count from the source's play count (0 = forever, n plays → n − 1 repeats, 1 → once). */
function gifLoopCount(media: LoadedMedia): number {
  if (media.kind !== 'animation' || media.loopCount === 0) return 0;
  return media.loopCount === 1 ? -1 : media.loopCount - 1;
}

function geometryOf(engine: RendererEngine): EngineGeometry {
  return { ...engine.getGrid(), geometry: engine.getGeometry(), maxRasterSize: engine.maxRasterSize };
}

/** The panel's plan for the settings as they are now, on this engine's grid. */
function currentPlan(engine: RendererEngine, ui: ExportUiState, media: LoadedMedia): ExportPlan {
  return planExport(ui, geometryOf(engine), { width: media.width, height: media.height });
}

/** Raster size options shared by every raster exporter: the whole scale and, for Custom, the exact width. */
function rasterSize(plan: ExportPlan): Pick<ExportOptions, 'scale' | 'targetWidth'> {
  return { scale: plan.renderScale, targetWidth: plan.targetWidth };
}

function pngOptions(plan: ExportPlan, ui: ExportUiState, sourceName?: string): PngExportOptions & Pick<ExportOptions, 'targetWidth'> {
  return { ...rasterSize(plan), margin: ui.margin, transparentBackground: ui.transparent && canBeTransparent('png', store().params), sourceName };
}

async function exportStill(engine: RendererEngine, plan: ExportPlan, ui: ExportUiState, sourceName: string): Promise<ExportResult> {
  const { margin } = ui;
  const transparentBackground = ui.transparent && canBeTransparent(plan.format, store().params);
  switch (plan.format) {
    case 'png':
      return exportPng(engine, pngOptions(plan, ui, sourceName));
    case 'svg':
      return exportSvg(engine.snapshot(), { margin, transparentBackground, svgText: ui.svgText, sourceName });
    case 'txt':
      return exportTxt(engine.snapshot(), { lineEnding: '\n', sourceName });
    default:
      return exportHtml(engine.snapshot(), { margin, sourceName });
  }
}

/** Clip levels, measured like the controller does for the preview (once per clip: sampling video seeks). */
const clipLevels = new WeakMap<LoadedMedia, Promise<Levels>>();

function levelsOf(media: LoadedAnimation | LoadedVideo): Promise<Levels> {
  let levels = clipLevels.get(media);
  if (!levels) {
    levels = sampleFramesForLevels(media).then(measureFrameLevels);
    clipLevels.set(media, levels);
    levels.catch(() => clipLevels.delete(media));
  }
  return levels;
}

/**
 * A separate engine with `params`, primed with a first frame so its grid exists (and the clip's
 * levels when auto-levels is on): the motion exports render on it, and the GIF size estimate
 * renders its sample frames on one.
 */
export async function snapshotEngine(media: LoadedAnimation | LoadedVideo, params: RenderParams, signal: AbortSignal): Promise<RendererEngine> {
  const engine = await createEngine();
  try {
    await engine.setParams(params);
    // Its programs compile in parallel (where supported) instead of on the first frame's main thread.
    await engine.warmup();
    signal.throwIfAborted();
    const primer = media.kind === 'video' ? media.element : await media.getFrame(0);
    engine.setSource(primer, { width: media.width, height: media.height, animated: true });
    if (params.autoLevels) engine.setLevels(await levelsOf(media));
    signal.throwIfAborted();
    return engine;
  } catch (error) {
    engine.dispose();
    throw error;
  }
}

async function exportMotion(
  media: LoadedAnimation | LoadedVideo,
  plan: ExportPlan,
  ui: ExportUiState,
  sourceName: string,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const { format } = plan;
  const { inPoint, outPoint } = store().playback;
  const range = exportRange(ui.trimOnly, inPoint, outPoint);
  // Only video is resampled to another rate; a GIF source keeps its own frame timing.
  const fps = media.kind === 'video' && ui.fps !== 'source' ? ui.fps : undefined;
  const frameCount = motionFrameCount(media, format, range, ui.fps, runtime.get().player?.frameTimes).count;
  // The settings the export engine is built with; the exporters take its colours from here too.
  const params = { ...store().params };
  const engine = await snapshotEngine(media, params, signal);
  try {
    const { margin } = ui;
    if (format === 'gif') {
      const frames =
        media.kind === 'animation' ? animationFrames(media, range) : videoFrames(media, { ...range, fps: gifFps(media.fps, fps) });
      // Source colour builds one palette for the whole GIF: sample it across the clip, not just its start.
      let paletteSamples: AsyncIterable<FrameInput> | undefined;
      if (params.colorMode === 'source') paletteSamples = media.kind === 'animation' ? animationSamples(media, range) : videoSamples(media, range);
      const gifOptions = { ...rasterSize(plan), margin, loopCount: gifLoopCount(media), frameCount, paletteSamples, sourceName, params };
      return await exportGif(engine, frames, gifOptions, onProgress, signal);
    }
    const input = media.kind === 'video' ? media : { kind: 'frames' as const, frames: animationFrames(media, range), frameCount };
    const videoOptions = {
      format,
      ...rasterSize(plan),
      margin,
      // MP4 has no alpha channel; the panel disables the switch, this keeps a stale value out.
      transparentBackground: ui.transparent && canBeTransparent(format, store().params),
      ...range,
      fps,
      includeAudio: ui.includeAudio && media.kind === 'video' && media.hasAudio,
      sourceName,
      paper: params.paper,
    };
    return await exportVideo(engine, input, videoOptions, onProgress, signal);
  } finally {
    engine.dispose();
  }
}

/** Pauses the preview for the duration of a motion export; the returned function resumes it if it was playing. */
function pausePreview(): () => void {
  const { player } = runtime.get();
  if (!player?.playing) return () => undefined;
  player.pause();
  return () => {
    // Only the same clip, and only if nobody started it meanwhile.
    if (runtime.get().player === player && !player.playing) player.play();
  };
}

/** Saves a finished export and says so (toast, announcement, job state). */
function saved(result: ExportResult, ui: ExportUiState, plan: ExportPlan): void {
  const fileName = finalName(result.fileName, ui.fileName);
  saveBlob(result.blob, fileName);
  store().setJob({ status: 'done', progress: 1, label: 'Saved', etaSec: null, result: { ...result, fileName } });
  const size = result.width && result.height ? `${result.width} × ${result.height} px · ` : '';
  const src = plan.source;
  const matches = src && plan.check.kind === 'exact' && result.width === plan.width ? ` · matches source ${ratioLabel(src.width, src.height)}` : '';
  toast({
    kind: 'success',
    icon: 'check',
    title: `Saved ${fileName}`,
    body: [`${size}${formatBytes(result.blob.size)}${matches}`, ...result.warnings].join(' '),
  });
}

function failed(error: unknown, label: string): void {
  const message = error instanceof Error ? error.message : String(error);
  store().setJob({ ...IDLE_JOB, status: 'error', error: message });
  // The panel shows failures inline (an alert); when it is closed (the file was closed meanwhile) a toast says it.
  if (!store().exportUi.open) toast({ kind: 'error', title: `${label} export failed`, body: message });
}

/**
 * A live camera's MP4 / WebM: recorded in real time from the preview engine, so the file shows
 * exactly what the preview shows, setting changes included, until stopRecording(). Closing the
 * camera (or opening another file) ends and saves it, so the camera never keeps running unseen.
 */
function recordLive(engine: RendererEngine, media: LoadedVideo, ui: ExportUiState, sourceName: string): void {
  const plan = currentPlan(engine, ui, media);
  let live: LiveRecording;
  try {
    live = startRecording(engine, media, { format: ui.format, ...rasterSize(plan), margin: ui.margin, transparentBackground: false, sourceName });
  } catch (error) {
    failed(error, FORMAT_LABEL[ui.format]);
    return;
  }
  jobMedia = media;
  runningFormat = ui.format;
  const progress = () => ({ container: live.container, elapsedSec: live.elapsedSec, frames: live.frames });
  const tick = setInterval(() => store().setJob({ recording: progress() }), RECORDING_TICK_MS);
  const unsubscribe = runtime.subscribe((refs) => {
    if (refs.media !== media) void stopRecording();
  });
  recording = {
    live,
    ui,
    plan,
    unwatch: () => {
      clearInterval(tick);
      unsubscribe();
    },
  };
  store().setJob({ ...IDLE_JOB, status: 'running', label: 'Recording', recording: progress() });
  store().announce(`Recording ${FORMAT_LABEL[ui.format]}`);
}

/** Takes the recording out of the job, so it is ended exactly once. */
function endRecording(): Recording | null {
  const ended = recording;
  recording = null;
  runningFormat = null;
  ended?.unwatch();
  if (ended) store().setJob({ recording: null });
  return ended;
}

/** Ends the recording and saves it. */
export async function stopRecording(): Promise<void> {
  const ended = endRecording();
  if (!ended) return;
  store().setJob({ label: 'Saving' });
  try {
    saved(await ended.live.stop(), ended.ui, ended.plan);
  } catch (error) {
    failed(error, FORMAT_LABEL[ended.ui.format]);
  }
}

async function discardRecording(): Promise<void> {
  const ended = endRecording();
  if (!ended) return;
  await ended.live.cancel();
  store().setJob(IDLE_JOB);
  store().announce('Recording discarded');
}

/** Export with the panel's current settings, save the file and report the outcome. */
export async function runExport(): Promise<void> {
  const s = store();
  const { engine, media } = runtime.get();
  if (s.job.status === 'running' || !engine || !media) return;
  if (isMotion(s.exportUi.format) && media.kind === 'video' && media.live) {
    recordLive(engine, media, { ...s.exportUi }, s.media.info?.name ?? media.name);
    return;
  }
  const ui = { ...s.exportUi };
  const format = ui.format;
  const label = FORMAT_LABEL[format];
  const sourceName = s.media.info?.name ?? media.name;
  const ac = new AbortController();
  controller = ac;
  runningFormat = format;
  jobMedia = media;
  const release = media.retain();
  const resume = isMotion(format) ? pausePreview() : () => undefined;
  s.setJob({ ...IDLE_JOB, status: 'running', label: isMotion(format) ? 'Preparing…' : 'Exporting…' });
  s.announce(`Exporting ${label}`);

  try {
    // A still renders from the preview engine: let it catch up with the settings first (a font or
    // charset change rebuilds glyphs asynchronously), so the file shows what the panel shows.
    if (!isMotion(format)) await engine.setParams(store().params);
    const plan = currentPlan(engine, ui, media);
    const onProgress = (p: ExportProgress) => store().setJob({ progress: p.fraction, label: p.label, etaSec: p.etaSec ?? null });
    let result: ExportResult;
    if (!isMotion(format)) result = await exportStill(engine, plan, ui, sourceName);
    else if (media.kind !== 'image') result = await exportMotion(media, plan, ui, sourceName, onProgress, ac.signal);
    else throw new Error(`${label} needs a GIF or video source.`);
    saved(result, ui, plan);
  } catch (error) {
    if (isAbortError(error)) {
      store().setJob(IDLE_JOB);
      store().announce('Export canceled');
      return;
    }
    failed(error, label);
  } finally {
    release();
    resume();
    if (controller === ac) {
      controller = null;
      runningFormat = null;
    }
  }
}

/** Copy PNG renders synchronously inside the click, so it is offered up to this many pixels. */
export const COPY_PNG_MAX_PIXELS = 16_000_000;

/** A copy's confirmation (the toast is also its announcement). */
function copied(title: string, body: string): void {
  toast({ kind: 'info', icon: 'copy', title, body });
}

/** Copy actions (from a click): the grid as plain text, the SVG markup or the PNG image. */
export async function copyExport(kind: 'text' | 'svg' | 'png'): Promise<void> {
  const { engine, media } = runtime.get();
  if (!engine || !media) return;
  const { exportUi } = store();
  try {
    if (kind === 'png') {
      const plan = currentPlan(engine, { ...exportUi, format: 'png' }, media);
      // Started synchronously so the ClipboardItem is created inside the click (Safari needs that).
      const png = exportPng(engine, pngOptions(plan, exportUi));
      await copyPng(png.then((r) => r.blob));
      const { width, height } = await png;
      copied('Copied PNG', `${width} × ${height} px.`);
      return;
    }
    const snapshot = engine.snapshot();
    if (kind === 'text') {
      await copyText(snapshotToText(snapshot, '\n'));
      copied(`Copied ${snapshot.rows} lines of text`, `${snapshot.cols} characters per line. Paste it into a monospace editor.`);
    } else {
      const transparentBackground = exportUi.transparent && canBeTransparent('svg', snapshot.params);
      const svg = await exportSvg(snapshot, { margin: exportUi.margin, transparentBackground, svgText: exportUi.svgText });
      await copySvg(await svg.blob.text());
      copied('Copied SVG', `${svg.width} × ${svg.height} px.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast({ kind: 'error', title: 'Couldn’t copy', body: message });
  }
}
