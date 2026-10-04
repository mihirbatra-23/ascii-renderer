/**
 * Dev harness for src/media: drop a file to inspect what the loaders report and drive the player.
 * Also exposes `window.harness` for the Playwright spec (tests/e2e/media.spec.ts).
 */
import type { FrameSource } from '../src/engine/types';
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import {
  createPlayer,
  loadMedia,
  MediaError,
  openCamera,
  sampleFramesForLevels,
  sniffFormat,
  type LoadedMedia,
  type Player,
} from '../src/media';

export interface MediaSummary {
  kind: LoadedMedia['kind'];
  name: string;
  width: number;
  height: number;
  fileSize: number;
  formatLabel: string;
  hasAlpha: boolean;
  frameCount?: number;
  durations?: number[];
  totalMs?: number;
  loopCount?: number;
  durationSec?: number;
  fps?: number;
  hasAudio?: boolean;
  codecLabel?: string;
  canDecodeFrames?: boolean;
}

export interface FrameStats {
  width: number;
  height: number;
  /** Alpha-weighted mean Rec. 709 luma, 0..1. */
  meanLuma: number;
  /** Fraction of pixels with alpha < 255. */
  transparentFraction: number;
}

function summarize(media: LoadedMedia): MediaSummary {
  const { kind, name, width, height, fileSize, formatLabel, hasAlpha } = media;
  const base = { kind, name, width, height, fileSize, formatLabel, hasAlpha };
  switch (media.kind) {
    case 'image':
      return base;
    case 'animation':
      return { ...base, frameCount: media.frameCount, durations: media.durations, totalMs: media.totalMs, loopCount: media.loopCount };
    case 'video':
      return {
        ...base,
        durationSec: media.durationSec,
        fps: media.fps,
        hasAudio: media.hasAudio,
        codecLabel: media.codecLabel,
        canDecodeFrames: media.canDecodeFrames,
      };
  }
}

function sourceSize(source: FrameSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  if (source instanceof VideoFrame) return { width: source.displayWidth, height: source.displayHeight };
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

function readPixels(source: FrameSource): ImageData {
  const { width, height } = sourceSize(source);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

function frameStats(source: FrameSource): FrameStats {
  const { data, width, height } = readPixels(source);
  let luma = 0;
  let weight = 0;
  let transparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (data[i + 3] < 255) transparent++;
    luma += a * (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    weight += a;
  }
  return { width, height, meanLuma: weight ? luma / weight / 255 : 0, transparentFraction: transparent / (width * height) };
}

/**
 * Compares our gifuct-js compositing with Chrome's native GIF decoder (WebCodecs ImageDecoder),
 * frame by frame. Returns the worst per-channel difference and how many frames differ at all.
 */
async function compareWithNativeDecoder(url: string): Promise<{ frames: number; nativeFrames: number; maxDiff: number; differingFrames: number }> {
  const blob = await (await fetch(url)).blob();
  const media = await loadMedia(blob, url);
  if (media.kind !== 'animation') throw new Error(`Not an animation: ${media.kind}`);
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif', premultiplyAlpha: 'none' });
  await decoder.tracks.ready;
  await decoder.completed;
  const nativeFrames = decoder.tracks.selectedTrack!.frameCount;
  let maxDiff = 0;
  let differingFrames = 0;
  for (let i = 0; i < media.frameCount; i++) {
    const ours = readPixels(await media.getFrame(i)).data;
    const { image } = await decoder.decode({ frameIndex: i });
    const native = readPixels(image).data;
    image.close();
    let frameMax = 0;
    for (let p = 0; p < ours.length; p++) frameMax = Math.max(frameMax, Math.abs(ours[p] - native[p]));
    if (frameMax > 0) differingFrames++;
    maxDiff = Math.max(maxDiff, frameMax);
  }
  decoder.close();
  media.dispose();
  return { frames: media.frameCount, nativeFrames, maxDiff, differingFrames };
}

/**
 * A variable-frame-rate MP4 (frames 1–4 ticks of 1/120 s apart, like a phone clip), each frame a
 * distinct flat grey so the picture identifies the frame. Returns the file and its frame times.
 */
async function vfrClip(frames: number): Promise<{ blob: Blob; times: number[] }> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const canvas = new OffscreenCanvas(64, 48);
  const ctx = canvas.getContext('2d')!;
  const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high'), keyFrameInterval: 0.5 });
  output.addVideoTrack(source, { frameRate: 120 });
  await output.start();
  const gaps = [2, 2, 3, 2, 1, 2, 4, 2, 2, 3, 2, 2];
  const times: number[] = [];
  let ticks = 0;
  for (let i = 0; i < frames; i++) {
    const gap = gaps[i % gaps.length];
    ctx.fillStyle = `rgb(${(i * 37) % 256}, ${(i * 37) % 256}, ${(i * 37) % 256})`;
    ctx.fillRect(0, 0, 64, 48);
    times.push(ticks / 120);
    await source.add(ticks / 120, gap / 120);
    ticks += gap;
  }
  await output.finalize();
  return { blob: new Blob([target.buffer!], { type: 'video/mp4' }), times };
}

/** A valid MP4 with only an AAC track (what a cut-off or audio-only recording looks like to the loader). */
async function audioOnlyMp4(): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const audio = new AudioBufferSource({ codec: 'aac', quality: new Quality('medium') });
  output.addAudioTrack(audio);
  await output.start();
  await audio.add(new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }));
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

let current: LoadedMedia | null = null;
let player: Player | null = null;

const harness = {
  loadMedia,
  createPlayer,
  sampleFramesForLevels,
  sniffFormat,
  frameStats,
  summarize,
  compareWithNativeDecoder,
  isMediaError: (error: unknown): error is MediaError => error instanceof MediaError,
  audioOnlyMp4,
  /**
   * Seeks a video, then closes it (player and media) before 'seeked' can arrive, as closing a clip
   * mid-scrub does; reports how long the seek's caller waited.
   */
  async seekThenDispose(url: string) {
    const media = await loadMedia(await (await fetch(url)).blob(), 'seek.mp4');
    if (media.kind !== 'video') throw new Error('expected a video');
    const p = createPlayer(media);
    const started = performance.now();
    const seek = p.seek(2);
    p.dispose();
    media.dispose();
    await seek;
    return { waitedMs: performance.now() - started };
  },
  /** Loads a URL into the page UI (and returns its summary), replacing what was shown. */
  async open(url: string, name = url.split('/').pop() ?? url): Promise<MediaSummary> {
    const blob = await (await fetch(url)).blob();
    return summarize(await show(blob, name));
  },
  /** Loads a URL and returns the MediaError code + message it throws, or null when it loads. */
  async loadError(url: string): Promise<{ code: string; message: string } | null> {
    const blob = await (await fetch(url)).blob();
    try {
      (await loadMedia(blob, url)).dispose();
      return null;
    } catch (error) {
      if (error instanceof MediaError) return { code: error.code, message: error.message };
      throw error;
    }
  },
  get media(): LoadedMedia | null {
    return current;
  },
  /**
   * Steps a variable-frame-rate clip `steps` times once its frame times are indexed and
   * reports the media time of every frame the player emitted.
   */
  async vfrStepping(steps: number) {
    const { blob, times } = await vfrClip(steps + 12);
    const media = await loadMedia(blob, 'vfr.mp4');
    if (media.kind !== 'video') throw new Error('expected a video');
    const p = createPlayer(media);
    const emitted: number[] = [];
    p.onFrame((_frame, t) => emitted.push(t));
    await new Promise<void>((resolve) => {
      if (p.frameTimes) return resolve();
      const off = p.onStateChange(() => {
        if (p.frameTimes) {
          off();
          resolve();
        }
      });
    });
    await p.seek(0);
    const indexed = Array.from(p.frameTimes ?? []);
    const start = emitted.length;
    for (let k = 0; k < steps; k++) await p.step(1);
    const stepped = emitted.slice(start);
    p.dispose();
    media.dispose();
    return { fps: media.fps, sourceTimes: times, indexed, stepped };
  },
  /** The camera as a live source through the player (needs --use-fake-device-for-media-stream). */
  async cameraPlayer() {
    const camera = await openCamera();
    const p = createPlayer(camera);
    let frames = 0;
    p.onFrame(() => frames++);
    await p.seek(0);
    const afterSeek = frames;
    p.play();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const whilePlaying = frames;
    const playing = p.playing;
    p.pause();
    const t = p.currentTime;
    await p.step(5);
    p.inPoint = 1;
    p.outPoint = 2;
    const stream = camera.element.srcObject as MediaStream;
    const summary = {
      kind: camera.kind,
      live: camera.live,
      width: camera.width,
      height: camera.height,
      durationSec: camera.durationSec,
      playerDuration: p.duration,
      frameTimes: p.frameTimes ?? null,
      afterSeek,
      whilePlaying,
      playing,
      pausedAfterStep: !p.playing,
      timeUnchangedByStep: Math.abs(p.currentTime - t) < 0.5,
      trim: [p.inPoint, p.outPoint],
    };
    p.dispose();
    const release = camera.retain();
    camera.dispose();
    const liveWhileRetained = stream.getTracks().every((tr) => tr.readyState === 'live');
    release();
    return { ...summary, liveWhileRetained, stoppedAfterRelease: stream.getTracks().every((tr) => tr.readyState === 'ended') };
  },
  /** The MediaError openCamera rejects with (code + message), or null if it opened. */
  async cameraError() {
    try {
      (await openCamera()).dispose();
      return null;
    } catch (error) {
      return error instanceof MediaError ? { code: error.code, message: error.message } : { code: 'other', message: String(error) };
    }
  },
  /** A large still: its analysis thumbnail, and the longest main-thread task while loading and sampling levels. */
  async bigStill(side: number) {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, side, side);
    g.addColorStop(0, '#102030');
    g.addColorStop(1, '#f0e0a0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, side, side);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(Math.round(e.duration))));
    observer.observe({ type: 'longtask' });
    const media = await loadMedia(blob, 'big.png');
    if (media.kind !== 'image') throw new Error('expected a still');
    const snapshots = await sampleFramesForLevels(media);
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    const result = {
      size: [media.width, media.height],
      thumbnail: [media.thumbnail.width, media.thumbnail.height],
      levelsSnapshot: snapshots.map((s) => [(s as OffscreenCanvas).width, (s as OffscreenCanvas).height]),
      longTasks,
    };
    media.dispose();
    return result;
  },
  get player(): Player | null {
    return player;
  },
};

export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}
window.harness = harness;

// ---- Manual UI -------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = $<HTMLCanvasElement>('preview');
const info = $<HTMLPreElement>('info');
const transport = $<HTMLDivElement>('transport');
const playButton = $<HTMLButtonElement>('play');
const timeLabel = $<HTMLSpanElement>('time');
const inInput = $<HTMLInputElement>('in');
const outInput = $<HTMLInputElement>('out');
const loopInput = $<HTMLInputElement>('loop');

function draw(frame: FrameSource): void {
  const { width, height } = sourceSize(frame);
  if (preview.width !== width || preview.height !== height) {
    preview.width = width;
    preview.height = height;
  }
  const ctx = preview.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(frame, 0, 0);
}

function syncTransport(): void {
  if (!player) return;
  playButton.textContent = player.playing ? 'Pause' : 'Play';
  timeLabel.textContent = `${player.currentTime.toFixed(3)} / ${player.duration.toFixed(3)} s`;
}

async function show(file: Blob, name: string): Promise<LoadedMedia> {
  player?.dispose();
  current?.dispose();
  player = null;
  current = null;
  info.classList.remove('error');
  info.textContent = 'Loading…';
  const started = performance.now();
  try {
    current = await loadMedia(file, name);
  } catch (error) {
    info.classList.add('error');
    info.textContent = error instanceof MediaError ? `${error.code}: ${error.message}` : String(error);
    throw error;
  }
  const loadMs = Math.round(performance.now() - started);
  const summary = { ...summarize(current), durations: undefined, loadMs };
  info.textContent = JSON.stringify(summary, null, 2);

  transport.hidden = current.kind === 'image';
  if (current.kind === 'image') {
    draw(current.bitmap);
  } else {
    player = createPlayer(current);
    player.onFrame((frame) => {
      draw(frame);
      syncTransport();
    });
    player.onStateChange(syncTransport);
    inInput.value = '0';
    outInput.value = player.duration.toFixed(3);
    await player.seek(0);
  }
  return current;
}

$<HTMLInputElement>('file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void show(file, file.name).catch(() => {});
});
const drop = $<HTMLDivElement>('drop');
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  const file = event.dataTransfer?.files[0];
  if (file) void show(file, file.name).catch(() => {});
});
playButton.addEventListener('click', () => (player?.playing ? player.pause() : player?.play()));
$('back').addEventListener('click', () => void player?.step(-1));
$('fwd').addEventListener('click', () => void player?.step(1));
loopInput.addEventListener('change', () => {
  if (player) player.loop = loopInput.checked;
});
inInput.addEventListener('change', () => {
  if (player) player.inPoint = Number(inInput.value);
});
outInput.addEventListener('change', () => {
  if (player) player.outPoint = Number(outInput.value);
});
