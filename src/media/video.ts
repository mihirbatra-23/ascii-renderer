/**
 * Video → LoadedVideo: a <video> element for real-time playback (the browser applies container
 * rotation and picks hardware decoders), plus Mediabunny for what the element does not expose:
 * frame rate, audio presence and codec.
 */
import { lifetimeMembers } from './lifetime';
import { assertImagePixels, assertVideoDuration } from './limits';
import { MediaError, type LoadedVideo } from './types';

/** How long the element may take to produce its first frame before loading is abandoned. */
const FIRST_FRAME_TIMEOUT_MS = 20_000;
/** Packets inspected to estimate the frame rate (a prefix is enough and keeps probing fast). */
const FPS_SAMPLE_PACKETS = 300;
/** Used only when the container could not be probed. */
const FALLBACK_FPS = 30;
const UNKNOWN_CODEC = 'unknown codec';

/** HTMLMediaElement error codes (the DOM MediaError interface; its name is shadowed by ours). */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const CODEC_LABELS: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
};

interface VideoProbe {
  codecLabel: string;
  fps: number;
  hasAudio: boolean;
  durationSec: number | null;
  canBeTransparent: boolean;
  /** WebCodecs can decode the track, i.e. frame-accurate export through Mediabunny will work. */
  canDecode: boolean;
}

export async function loadVideo(file: Blob, name: string, container: string): Promise<LoadedVideo> {
  const probe = await probeVideo(file);
  if (probe?.durationSec != null) assertVideoDuration(probe.durationSec);
  const codecLabel = probe?.codecLabel ?? UNKNOWN_CODEC;

  const url = URL.createObjectURL(file);
  const element = createVideoElement(url);
  let durationSec: number;
  try {
    await waitForFirstFrame(element, container, codecLabel);
    // WebM from MediaRecorder often has no duration header (Infinity); the probe scans for it.
    durationSec = Number.isFinite(element.duration) ? element.duration : (probe?.durationSec ?? 0);
    assertVideoDuration(durationSec);
    assertImagePixels(element.videoWidth, element.videoHeight);
  } catch (error) {
    releaseElement(element, url);
    throw error;
  }

  return {
    kind: 'video',
    name,
    width: element.videoWidth,
    height: element.videoHeight,
    fileSize: file.size,
    formatLabel: `${container} · ${codecLabel}`,
    hasAlpha: probe?.canBeTransparent ?? false,
    element,
    file,
    durationSec,
    fps: probe?.fps ?? FALLBACK_FPS,
    hasAudio: probe?.hasAudio ?? false,
    codecLabel,
    canDecodeFrames: probe?.canDecode ?? false,
    ...lifetimeMembers(() => releaseElement(element, url)),
  };
}

/**
 * Returns null when Mediabunny cannot parse the container (the element may still play it);
 * throws when the file parses but has no video track (audio only, or cut off before its video).
 */
async function probeVideo(file: Blob): Promise<VideoProbe | null> {
  const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    // A known container without a video track is a damaged or audio-only file, not an unknown type.
    if (!track) throw new MediaError('decode-failed', 'This file has no video track. It may be cut off or audio-only.');
    const [stats, audioTracks, canDecode, canBeTransparent, metadataDuration] = await Promise.all([
      track.computePacketStats(FPS_SAMPLE_PACKETS),
      input.getAudioTracks(),
      track.canDecode(),
      track.canBeTransparent(),
      input.getDurationFromMetadata(),
    ]);
    return {
      codecLabel: track.codec ? (CODEC_LABELS[track.codec] ?? track.codec.toUpperCase()) : UNKNOWN_CODEC,
      fps: stats.averagePacketRate > 0 ? stats.averagePacketRate : FALLBACK_FPS,
      hasAudio: audioTracks.length > 0,
      durationSec: metadataDuration ?? (await input.computeDuration()),
      canBeTransparent,
      canDecode,
    };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    return null;
  } finally {
    input.dispose();
  }
}

function createVideoElement(url: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  return video;
}

function waitForFirstFrame(video: HTMLVideoElement, container: string, codecLabel: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      // Audio-only playback of a file whose video codec is unsupported reports a 0×0 video.
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else reject(codecUnsupported(container, codecLabel));
    };
    const onError = () => {
      cleanup();
      const code = video.error?.code;
      reject(
        code === MEDIA_ERR_SRC_NOT_SUPPORTED || code === MEDIA_ERR_DECODE
          ? codecUnsupported(container, codecLabel)
          : new MediaError('decode-failed', 'This video could not be read. It may be damaged.'),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new MediaError('decode-failed', 'This video took too long to load. It may be damaged or unsupported.', {
          transient: true,
        }),
      );
    }, FIRST_FRAME_TIMEOUT_MS);
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function codecUnsupported(container: string, codecLabel: string): MediaError {
  const hint = codecLabel === 'HEVC'
    ? 'Open it in Safari, or convert it to H.264 MP4 and try again.'
    : 'Convert it to H.264 MP4 and try again.';
  const what = codecLabel === UNKNOWN_CODEC ? 'this' : codecLabel;
  return new MediaError('codec-unsupported', `This browser can't play ${what} video (${container}). ${hint}`);
}

function releaseElement(video: HTMLVideoElement, url: string): void {
  video.pause();
  video.removeAttribute('src');
  video.load(); // drops the decoder and buffered media
  URL.revokeObjectURL(url);
}
