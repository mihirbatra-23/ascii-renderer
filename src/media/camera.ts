/**
 * A live camera as a LoadedVideo (`live: true`): a muted inline <video> playing a getUserMedia stream.
 * It has no file, no duration (Infinity) and no seeking; the player plays and pauses it, and exports
 * record it in real time (src/export/recorder.ts). dispose() stops the camera.
 */
import { lifetimeMembers } from './lifetime';
import { MediaError, type LoadedVideo } from './types';

/** 720p at 30 fps from the front camera: plenty for an ASCII grid and light on every device. */
const DEFAULT_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
  facingMode: 'user',
};
/** How long the stream may take to deliver its first frame (the permission prompt comes before this). */
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const FALLBACK_FPS = 30;

/**
 * @param constraints  Video track constraints (default: 720p at 30 fps from the front camera).
 * @param options.signal  Gives up (AbortError) when it fires, e.g. if the user opens a file while
 *   the permission prompt is up; a camera that starts afterwards is stopped again at once.
 */
export async function openCamera(
  constraints: MediaTrackConstraints = DEFAULT_CONSTRAINTS,
  options: { signal?: AbortSignal } = {},
): Promise<LoadedVideo> {
  const { signal } = options;
  signal?.throwIfAborted();
  // Browsers only expose cameras to secure pages; say so instead of a generic failure.
  if (!globalThis.isSecureContext) {
    throw new MediaError(
      'camera-blocked',
      'The camera only works on a secure page. Open the app over https:// (or on localhost) and try again.',
    );
  }
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) throw new MediaError('camera-unavailable', 'This browser can’t use a camera.');

  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ video: constraints, audio: false });
  } catch (error) {
    throw cameraError(error);
  }
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  if (signal?.aborted) {
    stop();
    signal.throwIfAborted();
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stop();
    throw new MediaError('camera-unavailable', 'The camera delivered no video.');
  }

  const element = document.createElement('video');
  element.muted = true;
  element.defaultMuted = true;
  element.playsInline = true;
  element.srcObject = stream;
  try {
    await firstFrame(element);
    signal?.throwIfAborted();
  } catch (error) {
    element.srcObject = null;
    stop();
    throw error;
  }

  return {
    kind: 'video',
    live: true,
    name: 'Camera',
    width: element.videoWidth,
    height: element.videoHeight,
    fileSize: 0,
    formatLabel: track.label ? `Camera · ${track.label}` : 'Camera',
    hasAlpha: false,
    element,
    file: new Blob([]),
    durationSec: Infinity,
    fps: track.getSettings().frameRate ?? FALLBACK_FPS,
    hasAudio: false,
    codecLabel: 'Live',
    canDecodeFrames: false,
    ...lifetimeMembers(() => {
      element.pause();
      element.srcObject = null;
      stop();
    }),
  };
}

/** getUserMedia failures (DOMException names) as messages for the person in front of the camera. */
function cameraError(error: unknown): MediaError {
  switch (error instanceof DOMException ? error.name : '') {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MediaError(
        'camera-blocked',
        'Camera access is blocked. Allow the camera for this site (the camera icon in the address bar), then try again.',
      );
    case 'NotFoundError':
      return new MediaError('camera-unavailable', 'No camera was found. Connect one and try again.');
    case 'OverconstrainedError':
      return new MediaError('camera-unavailable', 'No camera supports the requested settings.');
    case 'NotReadableError':
    case 'AbortError':
      return new MediaError(
        'camera-unavailable',
        'The camera couldn’t start. Another app may be using it; close that app and try again.',
      );
    default:
      return new MediaError('camera-unavailable', 'The camera couldn’t be opened.');
  }
}

function firstFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoaded);
    };
    const onLoaded = () => {
      cleanup();
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else reject(new MediaError('camera-unavailable', 'The camera delivered no picture.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new MediaError('camera-unavailable', 'The camera took too long to start. Try again.'));
    }, FIRST_FRAME_TIMEOUT_MS);
    video.addEventListener('loadeddata', onLoaded);
  });
}
