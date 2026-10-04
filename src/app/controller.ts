/**
 * Media lifecycle: picked / dropped / pasted files, samples and the camera become runtime.media
 * (+ a player for GIFs, video and the camera), the engine's source and levels, and store.media /
 * store.playback.
 *
 *   openFile(file, name?)    load by magic bytes; the previous media stays on screen (and playing)
 *                            until the new one is ready
 *   openSample(url, name)    a bundled sample (public/samples)
 *   openCamera()             a live camera stream (asks for permission)
 *   closeMedia()             back to the start screen; stops the camera, frees the engine's source
 *
 * Exactly one presentation owns the engine's source at a time. An open prepares the new media
 * completely off screen (levels and its first frame) and then commits in one synchronous step:
 * the previous player is detached before the new frame is set, and every frame listener checks
 * that its presentation is still the current one, so a late frame from the old clip can never
 * replace the new picture. A stale or failed open never touched the engine or the
 * previous player, so there is nothing to restore: the previous media simply carries on.
 *
 * Opens are latest-wins: a slower earlier load that finishes after a newer one is discarded.
 * Failures become toasts with a human message; the stage keeps the last good frame.
 */
import { measureFrameLevels, type FrameSource, type Levels, type RendererEngine, type SourceInfo } from '../engine';
import {
  createPlayer,
  loadMedia,
  MediaError,
  openCamera as openCameraStream,
  sampleFramesForLevels,
  type LoadedMedia,
  type Player,
} from '../media';
import { INITIAL_PLAYBACK, useStore, type MediaInfo } from '../state/store';
import { toast, type ToastOptions } from '../ui/kit';
import { FORMATS } from '../ui/start/samples';
import { ensureEngine, requestRender } from './engineHost';
import { runtime } from './runtime';

// ---------------------------------------------------------------- opening

let openSeq = 0;

export function openFile(file: Blob, name = file instanceof File ? file.name : 'pasted image'): Promise<void> {
  return open(name, () => loadMedia(file, name), () => void openFile(file, name));
}

export async function openSample(url: string, name: string): Promise<void> {
  const seq = ++openSeq;
  useStore.getState().setMedia({ status: 'loading', error: undefined, pending: name });
  let blob: Blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
    blob = await res.blob();
  } catch (e) {
    if (seq === openSeq) fail(e, name, () => void openSample(url, name), 'Couldn’t load the sample');
    return;
  }
  if (seq === openSeq) await openFile(blob, name);
}

export function openCamera(): Promise<void> {
  return open('the camera', () => openCameraStream(), () => void openCamera(), 'Couldn’t start the camera');
}

/** Whether this browser can offer a camera at all (secure context with getUserMedia). */
export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

async function open(label: string, load: () => Promise<LoadedMedia>, retry: () => void, failTitle?: string): Promise<void> {
  const seq = ++openSeq;
  const store = useStore.getState();
  store.setMedia({ status: 'loading', error: undefined, pending: label });
  store.setUi({ dragOver: null });
  let media: LoadedMedia | undefined;
  try {
    const [loaded, engine] = await Promise.allSettled([load(), ensureEngine()]);
    if (loaded.status === 'rejected') throw loaded.reason;
    media = loaded.value;
    if (engine.status === 'rejected') throw engine.reason;
    if (seq !== openSeq) return media.dispose();
    const next = await prepare(media);
    if (seq !== openSeq) {
      next.player?.dispose();
      return media.dispose();
    }
    commit(next, engine.value);
  } catch (e) {
    // Nothing of a failed open reached the engine; only its own media needs releasing.
    if (media && runtime.get().media !== media) media.dispose();
    if (seq === openSeq) fail(e, media?.name ?? label, retry, failTitle);
  }
}

// ---------------------------------------------------------------- preparing (off screen)

/** How long an open waits for a clip's 8-frame levels before showing it with the first frame's own. */
const CLIP_LEVELS_WAIT_MS = 300;
/** A camera's auto-exposure settles within about a second; its levels are measured again then. */
const LIVE_LEVELS_DELAY_MS = 1200;
/** A source that has not produced a picture by then is reported instead of waiting forever. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

interface Prepared {
  media: LoadedMedia;
  player?: Player;
  info: SourceInfo;
  first: { frame: FrameSource; time: number };
  levels: Levels;
  /** Better levels on the way (a clip's slow 8-frame sample, a camera after auto-exposure settles). */
  refine?: Promise<Levels>;
}

async function prepare(media: LoadedMedia): Promise<Prepared> {
  const info: SourceInfo = { width: media.width, height: media.height, animated: media.kind !== 'image' };
  if (media.kind === 'image') {
    // Stills measure before the first draw (one 256 px copy), so the picture never jumps.
    const levels = measureFrameLevels(await sampleFramesForLevels(media));
    return { media, info, first: { frame: media.bitmap, time: 0 }, levels };
  }
  const player = createPlayer(media);
  try {
    if (media.kind === 'video' && media.live) {
      // A camera has nothing to sample ahead: the first frame's levels, measured again once its
      // auto-exposure has settled.
      const first = await firstFrame(player, true);
      const refine = delay(LIVE_LEVELS_DELAY_MS).then(() => measureFrameLevels([media.element]));
      return { media, player, info, first, levels: measureFrameLevels([first.frame]), refine };
    }
    // Clip levels come from ~8 frames across it. Usually they arrive within a moment, so the first
    // frame already uses them; a slow sample is applied when it lands. Either way the previous
    // file's levels never touch this clip. (While it is awaited here, the sample runs before the
    // first frame is fetched, so it cannot push that frame out of the animation's frame cache.)
    const clipLevels = sampleFramesForLevels(media).then(measureFrameLevels);
    const early = await within(clipLevels, CLIP_LEVELS_WAIT_MS);
    const first = await firstFrame(player, false);
    if (early) return { media, player, info, first, levels: early };
    return { media, player, info, first, levels: measureFrameLevels([first.frame]), refine: clipLevels };
  } catch (e) {
    player.dispose();
    throw e;
  }
}

/**
 * The first picture, captured off screen: a seek to 0 for clips, the first presented frame for a
 * live stream (which starts playing here).
 */
function firstFrame(player: Player, live: boolean): Promise<{ frame: FrameSource; time: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new MediaError('decode-failed', 'No picture arrived from this source.'));
    }, FIRST_FRAME_TIMEOUT_MS);
    const off = player.onFrame((frame, time) => {
      clearTimeout(timer);
      off();
      resolve({ frame, time });
    });
    if (live) player.play();
    else
      player.seek(0).catch((e: unknown) => {
        clearTimeout(timer);
        off();
        reject(e);
      });
  });
}

/** The value if `promise` settles successfully within `ms`, else undefined (it keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- the presentation (on screen)

interface Presentation {
  media: LoadedMedia;
  player?: Player;
  /** Stops this presentation's frames from reaching the engine. */
  detach(): void;
}

/** What the engine shows; frame listeners of any other presentation are ignored. */
let current: Presentation | null = null;

/** Synchronous from detaching the old player to the new store state, so nothing interleaves. */
function commit(next: Prepared, engine: RendererEngine): void {
  const prev = current;
  prev?.detach();
  engine.setLevels(next.levels);
  engine.setSource(next.first.frame, next.info);
  engine.resetHistory();
  const presentation: Presentation = { media: next.media, player: next.player, detach: () => undefined };
  if (next.player) presentation.detach = wirePlayer(presentation, next.player, engine, next.info, next.first.time);
  current = presentation;
  runtime.set({ media: next.media, player: next.player });
  // Released only once the engine holds the new frame (ARCHITECTURE Wiring 8). An export that
  // retains the old media keeps it alive until it finishes.
  prev?.player?.dispose();
  prev?.media.dispose();

  const { media } = next;
  const store = useStore.getState();
  store.setMedia({ status: 'ready', info: mediaInfo(media), error: undefined, pending: undefined });
  store.setView({ probe: null, zoom: 'fit', panX: 0, panY: 0 });
  // Loop and speed are the user's choices and carry over; the transport mirrors the rest.
  store.setPlayback({ ...INITIAL_PLAYBACK, loop: store.playback.loop, rate: store.playback.rate });
  store.announce(media.kind === 'video' && media.live ? 'Camera on' : `Opened ${media.name}`);
  requestRender();

  if (next.player && !next.player.playing) next.player.play();
  next.refine?.then(
    (levels) => {
      if (current !== presentation) return;
      engine.setLevels(levels);
      requestRender();
    },
    // The first frame's levels stay; the clip still plays.
    () => undefined,
  );
}

/** A frame that does not follow the previous one (seek, loop wrap, step back) restarts temporal history. */
const CONTINUOUS_SEC = 0.25;

/**
 * Frames go straight to the engine while this presentation is current. The transport
 * (ui/transport/playback.ts) binds the same player to mirror its state into store.playback.
 */
function wirePlayer(presentation: Presentation, player: Player, engine: RendererEngine, info: SourceInfo, firstTime: number): () => void {
  let lastTime = firstTime;
  const off = player.onFrame((frame, time) => {
    if (current !== presentation) return;
    engine.setSource(frame, info);
    if (time < lastTime || time - lastTime > CONTINUOUS_SEC) engine.resetHistory();
    lastTime = time;
    requestRender();
  });
  return () => {
    off();
    player.pause();
  };
}

export function closeMedia(): void {
  // An open still in flight is now stale and discards itself.
  openSeq++;
  const prev = current;
  current = null;
  prev?.detach();
  runtime.set({ media: undefined, player: undefined });
  // The start screen needs no source; free the GPU copy of a possibly huge image.
  runtime.get().engine?.releaseSource();
  prev?.player?.dispose();
  prev?.media.dispose();
  const store = useStore.getState();
  store.setMedia({ status: 'empty', info: undefined, error: undefined, pending: undefined });
  store.setPlayback(INITIAL_PLAYBACK);
  store.setView({ probe: null, zoom: 'fit', panX: 0, panY: 0 });
  store.setExportUi({ open: false });
  if (prev?.media.kind === 'video' && prev.media.live) store.announce('Camera off');
}

function mediaInfo(media: LoadedMedia): MediaInfo {
  const base = { name: media.name, kind: media.kind, width: media.width, height: media.height, fileSize: media.fileSize, formatLabel: media.formatLabel };
  switch (media.kind) {
    case 'image':
      return base;
    case 'animation':
      return { ...base, durationSec: media.totalMs / 1000, frameCount: media.frameCount, fps: (media.frameCount * 1000) / media.totalMs };
    case 'video':
      if (media.live) return { ...base, formatLabel: 'Camera', fps: media.fps, live: true };
      return {
        ...base,
        formatLabel: media.codecLabel,
        durationSec: media.durationSec,
        fps: media.fps,
        frameCount: Math.max(1, Math.round(media.durationSec * media.fps)),
      };
  }
}

// ---------------------------------------------------------------- errors

function fail(e: unknown, name: string, retry: () => void, title?: string): void {
  const store = useStore.getState();
  const t = errorToast(e, name, title);
  // The editor keeps the media it had; from the start screen, the start screen stays.
  store.setMedia(current ? { status: 'ready', error: t.title, pending: undefined } : { status: 'empty', info: undefined, error: t.title, pending: undefined });
  toast(retryable(e) ? { ...t, actions: [{ label: 'Try again', onClick: retry }] } : t);
}

/**
 * Only failures that can go differently a second time offer a retry: unexpected errors (a failed read or
 * fetch) and media errors marked transient. A damaged or unsupported file fails the same way every time.
 */
function retryable(e: unknown): boolean {
  return !(e instanceof MediaError) || e.transient;
}

const SUPPORTED = `Try ${FORMATS.slice(0, -1).join(', ')} or ${FORMATS.at(-1)}.`;

type ErrorToast = ToastOptions & { body: string };

function errorToast(e: unknown, name: string, title?: string): ErrorToast {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof MediaError)) return { kind: 'error', title: title ?? `Couldn’t open ${name}`, body: message };
  switch (e.code) {
    case 'unsupported-format':
      return { kind: 'error', icon: 'file-x', title: 'That file type isn’t supported', body: `${name} can’t be opened here. ${SUPPORTED}` };
    case 'heic-unsupported':
      return { kind: 'error', icon: 'file-x', title: 'HEIC isn’t supported here', body: message };
    case 'too-large':
      return { kind: 'error', title: `${name} is too large`, body: message };
    case 'empty-file':
      return { kind: 'error', icon: 'file-x', title: `${name} is empty`, body: 'Nothing was copied into it. Choose the original file again.' };
    case 'decode-failed':
    case 'codec-unsupported':
      return { kind: 'error', title: `Couldn’t decode ${name}`, body: message };
    case 'camera-blocked':
      return { kind: 'error', title: 'Camera access is blocked', body: message };
    case 'camera-unavailable':
      return { kind: 'error', title: 'The camera isn’t available', body: message };
  }
}
