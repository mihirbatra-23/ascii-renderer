/**
 * Playback control behind the transport and the playback shortcuts. Drives runtime.player and
 * mirrors its state into store.playback, so readouts subscribe to the store like everything else.
 *
 * Speed: the Player interface has no rate. Video sets its element's playbackRate. Animations at
 * a rate other than 1× run on a scaled clock here, which seeks the paused player once per frame
 * change; if anything starts the player natively meanwhile, the clock takes over again.
 *
 * Seeks are latest-wins (a scrub never queues stale positions) and reset the engine's temporal
 * history, so stability does not smear the frames on either side of the jump together. The seek
 * queue belongs to its binding, so a seek still in flight on a closed clip can never hold up the
 * next clip's scrubbing.
 *
 * A live camera binds too, but only play / pause apply: it has no timeline, speed or loop.
 */
import { useSyncExternalStore } from 'react';
import { runtime } from '../../app/runtime';
import type { LoadedAnimation, LoadedMedia, LoadedVideo, Player } from '../../media';
import { wrapPlaybackTime } from '../../media/timeline';
import { useStore, type PlaybackState } from '../../state/store';
import { clipOf, type Clip } from './clip';

interface ScaledClock {
  raf: number;
  anchorTime: number;
  anchorWallMs: number;
  /** Frame last requested from the player. */
  frame: number;
  time: number;
}

interface Binding {
  player: Player;
  media: LoadedAnimation | LoadedVideo;
  live: boolean;
  clip: Clip;
  /** The player's frame timestamps the clip was built from (video: they arrive after binding). */
  frameTimes: Float64Array | null;
  clock: ScaledClock | null;
  /** Latest-wins seek queue: the newest target, and whether a seek is being awaited. */
  pendingSeek: number | null;
  seeking: boolean;
}

let bound: Binding | null = null;
const clipListeners = new Set<() => void>();
const clipChanged = () => clipListeners.forEach((fn) => fn());

const store = () => useStore.getState();

/** Writes only the fields that changed, so idle subscribers are not notified for nothing. */
function patchPlayback(patch: Partial<PlaybackState>): void {
  const current = store().playback;
  const changed = (Object.keys(patch) as (keyof PlaybackState)[]).some((k) => patch[k] !== current[k]);
  if (changed) store().setPlayback(patch);
}

function timeOf(b: Binding): number {
  return b.clock ? b.clock.time : b.player.currentTime;
}

function mirror(b: Binding, time = timeOf(b)): void {
  const { player, clip } = b;
  // A camera has no position worth showing; only whether it is running (pause freezes the frame).
  if (b.live) return patchPlayback({ playing: player.playing });
  patchPlayback({
    playing: player.playing || !!b.clock,
    time,
    frame: clip.frameAt(time),
    frameCount: clip.frameCount,
    duration: clip.duration,
    inPoint: player.inPoint,
    outPoint: player.outPoint,
    loop: player.loop,
  });
}

function stopClock(b: Binding): void {
  if (!b.clock) return;
  cancelAnimationFrame(b.clock.raf);
  b.clock = null;
}

function startClock(b: Binding): void {
  const { player, clip } = b;
  stopClock(b);
  let from = player.currentTime;
  if (from < player.inPoint || from >= player.outPoint - 1e-6) from = player.inPoint;
  const clock: ScaledClock = { raf: 0, anchorTime: from, anchorWallMs: performance.now(), frame: -1, time: from };
  // Set before pausing, so the pause's state event already reads as playing.
  b.clock = clock;
  player.pause();
  const tick = () => {
    if (b.clock !== clock) return;
    const elapsed = ((performance.now() - clock.anchorWallMs) / 1000) * store().playback.rate;
    const { time, ended } = wrapPlaybackTime(clock.anchorTime + elapsed, player.inPoint, player.outPoint, player.loop);
    clock.time = time;
    const frame = clip.frameAt(time);
    if (frame !== clock.frame) {
      clock.frame = frame;
      void player.seek(time);
    }
    if (ended) b.clock = null;
    else clock.raf = requestAnimationFrame(tick);
    mirror(b, time);
  };
  clock.raf = requestAnimationFrame(tick);
  mirror(b);
}

function usesClock(b: Binding, rate = store().playback.rate): boolean {
  return b.media.kind === 'animation' && rate !== 1;
}

function applyRate(b: Binding, rate: number): void {
  if (b.live) return;
  if (b.media.kind === 'video') {
    b.media.element.playbackRate = rate;
    return;
  }
  if (b.clock) {
    if (rate === 1) {
      const t = b.clock.time;
      stopClock(b);
      void b.player.seek(t).then(() => bound === b && b.player.play());
    } else {
      // Re-anchor at the current position so a speed change never jumps.
      b.clock.anchorTime = b.clock.time;
      b.clock.anchorWallMs = performance.now();
    }
  } else if (b.player.playing && rate !== 1) {
    startClock(b);
  }
}

/** Connects the transport to a player; returns the disconnect function. */
export function bindPlayer(player: Player, media: LoadedMedia): () => void {
  if (media.kind === 'image') return () => undefined;
  const live = media.kind === 'video' && media.live === true;
  const frameTimes = player.frameTimes ?? null;
  const b: Binding = { player, media, live, clip: clipOf(media, frameTimes), frameTimes, clock: null, pendingSeek: null, seeking: false };
  bound = b;
  clipChanged();
  if (!live) player.loop = store().playback.loop;
  applyRate(b, store().playback.rate);

  const offState = player.onStateChange(() => {
    // A video's real frame timestamps are indexed in the background; frame numbers follow them.
    if (player.frameTimes && player.frameTimes !== b.frameTimes) {
      b.frameTimes = player.frameTimes;
      b.clip = clipOf(media, player.frameTimes);
      clipChanged();
    }
    // Something started the player at 1× while a different speed is selected.
    if (player.playing && usesClock(b)) startClock(b);
    else mirror(b);
  });
  const offFrame = player.onFrame((_frame, t) => {
    if (!b.clock) mirror(b, t);
  });
  const offLoop = useStore.subscribe(
    (s) => s.playback.loop,
    (loop) => {
      if (!live && player.loop !== loop) player.loop = loop;
    },
  );
  const offRate = useStore.subscribe((s) => s.playback.rate, (rate) => applyRate(b, rate));
  mirror(b);

  return () => {
    stopClock(b);
    offState();
    offFrame();
    offLoop();
    offRate();
    // Whatever this binding still had queued is dropped with it.
    b.pendingSeek = null;
    if (bound === b) {
      bound = null;
      clipChanged();
    }
  };
}

/** The bound clip (frame timing, duration) for components that draw it; null while nothing is bound. */
export function useBoundClip(): Clip | null {
  return useSyncExternalStore(
    (fn) => {
      clipListeners.add(fn);
      return () => clipListeners.delete(fn);
    },
    () => bound?.clip ?? null,
  );
}

export function isPlaying(): boolean {
  return !!bound && (bound.player.playing || !!bound.clock);
}

export function currentTime(): number {
  return bound ? timeOf(bound) : 0;
}

export function currentClip(): Clip | null {
  return bound?.clip ?? null;
}

export function play(): void {
  const b = bound;
  if (!b) return;
  if (usesClock(b)) startClock(b);
  else b.player.play();
}

export function pause(): void {
  const b = bound;
  if (!b) return;
  stopClock(b);
  b.player.pause();
  mirror(b);
}

export function togglePlay(): void {
  if (isPlaying()) pause();
  else play();
}

/** ±n frames (pauses). */
export function step(frames: number): void {
  const b = bound;
  if (!b || b.live) return;
  stopClock(b);
  runtime.get().engine?.resetHistory();
  void b.player.step(frames);
}

/** Latest-wins seek; the playhead moves at once, the frame follows as fast as it decodes. */
export function seek(timeSec: number): void {
  const b = bound;
  if (!b || b.live) return;
  const t = Math.min(b.player.outPoint, Math.max(b.player.inPoint, timeSec));
  if (b.clock) {
    b.clock.anchorTime = t;
    b.clock.anchorWallMs = performance.now();
  }
  patchPlayback({ time: t, frame: b.clip.frameAt(t) });
  b.pendingSeek = t;
  if (!b.seeking) void drainSeeks(b);
}

async function drainSeeks(b: Binding): Promise<void> {
  b.seeking = true;
  try {
    while (b.pendingSeek !== null && bound === b) {
      const t = b.pendingSeek;
      b.pendingSeek = null;
      runtime.get().engine?.resetHistory();
      await b.player.seek(t);
    }
  } finally {
    b.seeking = false;
  }
}

/**
 * The frame boundary at or before `timeSec` (the start of the frame on screen then; the clip's end
 * stays the end). Trim edges are always boundaries: an export writes whole frames, so an edge
 * inside a frame wrote a sliver of it that the panel's frame count did not include.
 */
function boundaryAtOrBefore(clip: Clip, timeSec: number): number {
  if (timeSec >= clip.duration - 1e-6) return clip.duration;
  return clip.frameStart(clip.frameAt(timeSec));
}

/** In point at the start of the frame shown at `timeSec`. */
export function setInPoint(timeSec: number): void {
  const b = bound;
  if (!b || b.live) return;
  b.player.inPoint = boundaryAtOrBefore(b.clip, timeSec);
  mirror(b);
}

/** Out point at the frame boundary at or before `timeSec`, and at least one frame after the in point. */
export function setOutPoint(timeSec: number): void {
  const b = bound;
  if (!b || b.live) return;
  const { clip, player } = b;
  const out = boundaryAtOrBefore(clip, timeSec);
  player.outPoint = out > player.inPoint ? out : clip.frameStart(clip.frameAt(player.inPoint) + 1);
  mirror(b);
}

export function setLoop(loop: boolean): void {
  store().setPlayback({ loop });
}

export function setRate(rate: number): void {
  store().setPlayback({ rate });
}
