/** Frames for auto-levels, computed once per clip from frames spread across it (docs/ALGORITHM.md §3). */
import type { FrameSource } from '../engine/types';
import { scaledCopy } from './canvas';
import { MediaError, type LoadedMedia, type LoadedVideo } from './types';

/** Auto-levels analyse a ≤ 256 px downsample, so snapshots need be no larger. */
const SNAPSHOT_SIDE = 256;

/**
 * Small (≤ 256 px) snapshots owned by the caller: unlike getFrame() results they are never evicted
 * from a cache, and sampling a video uses a separate element so playback is not disturbed.
 * Stills yield one snapshot.
 */
export async function sampleFramesForLevels(media: LoadedMedia, count = 8): Promise<FrameSource[]> {
  switch (media.kind) {
    case 'image':
      return [scaledCopy(media.thumbnail, media.thumbnail.width, media.thumbnail.height, SNAPSHOT_SIDE)];
    case 'animation': {
      const snapshots: FrameSource[] = [];
      for (const index of spreadIndices(media.frameCount, count)) {
        const frame = await media.getFrame(index);
        snapshots.push(scaledCopy(frame, media.width, media.height, SNAPSHOT_SIDE));
      }
      return snapshots;
    }
    case 'video':
      return sampleVideo(media, count);
  }
}

/** Frame indices at the centres of `count` equal slices of the clip (every frame if fewer). */
export function spreadIndices(frameCount: number, count: number): number[] {
  if (frameCount <= count) return Array.from({ length: frameCount }, (_, i) => i);
  return Array.from({ length: count }, (_, k) => Math.floor(((k + 0.5) * frameCount) / count));
}

async function sampleVideo(media: LoadedVideo, count: number): Promise<FrameSource[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = media.element.currentSrc || media.element.src;
  try {
    await nextEvent(video, 'loadeddata');
    const snapshots: FrameSource[] = [];
    for (let k = 0; k < count; k++) {
      const seeked = nextEvent(video, 'seeked');
      video.currentTime = ((k + 0.5) / count) * media.durationSec;
      await seeked;
      snapshots.push(scaledCopy(video, video.videoWidth, video.videoHeight, SNAPSHOT_SIDE));
    }
    return snapshots;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function nextEvent(video: HTMLVideoElement, type: 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (event: Event) => {
      video.removeEventListener(type, settle);
      video.removeEventListener('error', settle);
      if (event.type === 'error') reject(new MediaError('decode-failed', 'Frames couldn’t be read from this video.'));
      else resolve();
    };
    video.addEventListener(type, settle);
    video.addEventListener('error', settle);
  });
}
