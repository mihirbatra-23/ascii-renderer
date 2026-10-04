import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../../src/media/animation-player';
import { CLOSED_MESSAGE } from '../../src/media/lifetime';
import type { LoadedAnimation } from '../../src/media/types';

type Frame = Awaited<ReturnType<LoadedAnimation['getFrame']>>;

/** An animation whose frame requests stay pending until the test settles them. */
function deferredAnimation(frameCount: number) {
  const requests: { index: number; resolve: (f: Frame) => void; reject: (e: unknown) => void }[] = [];
  const media = {
    kind: 'animation',
    name: 'test.gif',
    width: 4,
    height: 4,
    fileSize: 1,
    formatLabel: 'GIF',
    hasAlpha: false,
    frameCount,
    durations: Array.from({ length: frameCount }, () => 100),
    totalMs: frameCount * 100,
    loopCount: 0,
    retain: () => () => {},
    dispose: () => {},
    getFrame: (index: number) =>
      new Promise<Frame>((resolve, reject) => requests.push({ index, resolve, reject })),
    readFrame: () => Promise.reject(new Error('unused')),
  } satisfies LoadedAnimation;
  return { media, requests };
}

describe('AnimationPlayer', () => {
  const reportError = vi.fn();
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCallbacks = [];
    reportError.mockReset();
    vi.stubGlobal('reportError', reportError);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafCallbacks.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  // replacing a playing GIF pauses the player (starting a frame request) and then disposes the
  // player and the media; the pending request rejects as closed and must not surface as an uncaught error.
  it('ignores a frame request that fails because the media was closed after dispose', async () => {
    const { media, requests } = deferredAnimation(10);
    const player = new AnimationPlayer(media);
    player.play();
    rafCallbacks.shift()?.(performance.now());
    expect(requests).toHaveLength(1);

    player.pause();
    player.dispose();
    for (const r of requests) r.reject(new Error(CLOSED_MESSAGE));
    await new Promise((r) => setTimeout(r, 0));

    expect(reportError).not.toHaveBeenCalled();
  });

  it('a seek in flight when the player is disposed resolves instead of rejecting', async () => {
    const { media, requests } = deferredAnimation(10);
    const player = new AnimationPlayer(media);
    const seek = player.seek(0.35);
    player.dispose();
    requests[0].reject(new Error(CLOSED_MESSAGE));
    await expect(seek).resolves.toBeUndefined();
  });

  it('still reports a decode failure while the player is alive', async () => {
    const { media, requests } = deferredAnimation(10);
    const player = new AnimationPlayer(media);
    const seek = player.seek(0.2);
    requests[0].reject(new Error('corrupt frame'));
    await expect(seek).rejects.toThrow('corrupt frame');
    player.dispose();
  });
});
