/**
 * Transport for GIFs and video (spec §4.3), docked under the stage: the controls row and the
 * timeline. It binds runtime.player while mounted (mirroring its state into store.playback) and
 * routes the playback shortcuts through the same controller, so keys and buttons agree.
 *
 * A live camera gets only the play / pause row (pause freezes the frame): it has no timeline.
 */
import { useEffect } from 'react';
import { registerDefaultShortcuts } from '../../app/defaultShortcuts';
import { useRuntime } from '../../app/runtime';
import { getShortcuts, updateShortcut, type ShortcutAction } from '../../app/shortcuts';
import { useStore } from '../../state/store';
import { bindPlayer, currentTime, setInPoint, setLoop, setOutPoint, setRate, step, togglePlay } from './playback';
import Timeline from './Timeline';
import TransportRow, { LiveRow } from './TransportRow';
import './transport.css';

const SHORTCUTS: Record<string, NonNullable<ShortcutAction['handler']>> = {
  'playback.toggle': () => togglePlay(),
  'playback.prev': (e) => step(e.shiftKey ? -10 : -1),
  'playback.next': (e) => step(e.shiftKey ? 10 : 1),
  'playback.loop': () => setLoop(!useStore.getState().playback.loop),
  'playback.in': () => setInPoint(currentTime()),
  'playback.out': () => setOutPoint(currentTime()),
  'playback.slow': () => setRate(0.5),
  'playback.normal': () => setRate(1),
};

function usePlaybackShortcuts(): void {
  useEffect(() => {
    // Child effects run before App's; make sure the defaults exist before replacing handlers.
    registerDefaultShortcuts();
    const previous = getShortcuts().filter((a) => a.id in SHORTCUTS);
    for (const [id, handler] of Object.entries(SHORTCUTS)) updateShortcut(id, { handler });
    return () => {
      for (const a of previous) updateShortcut(a.id, { handler: a.handler });
    };
  }, []);
}

export default function Transport() {
  const player = useRuntime((r) => r.player);
  const media = useRuntime((r) => r.media);
  useEffect(() => (player && media ? bindPlayer(player, media) : undefined), [player, media]);
  usePlaybackShortcuts();
  if (media?.kind === 'video' && media.live) {
    return (
      <div className="tp live" role="group" aria-label="Camera">
        <LiveRow />
      </div>
    );
  }
  return (
    <div className="tp" role="group" aria-label="Playback">
      <TransportRow />
      {media && media.kind !== 'image' && <Timeline media={media} />}
    </div>
  );
}
