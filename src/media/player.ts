import { AnimationPlayer } from './animation-player';
import type { LoadedAnimation, LoadedVideo, Player } from './types';
import { VideoPlayer } from './video-player';

/**
 * One transport for animations and videos. Playback loops by default over the full clip.
 * Subscribe with onFrame, then `await player.seek(0)` to get the first frame on screen.
 */
export function createPlayer(media: LoadedAnimation | LoadedVideo): Player {
  return media.kind === 'animation' ? new AnimationPlayer(media) : new VideoPlayer(media);
}
