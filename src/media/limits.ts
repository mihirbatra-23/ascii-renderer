/** MEDIA_LIMITS checks with messages written for the person who dropped the file. */
import { MEDIA_LIMITS, MediaError } from './types';

export function assertFileSize(bytes: number): void {
  // The UI names the empty file in its title; the message says what to do about it.
  if (bytes === 0) throw new MediaError('empty-file', 'Nothing was copied into it. Choose the original file again.');
  if (bytes > MEDIA_LIMITS.maxFileBytes) {
    throw new MediaError(
      'too-large',
      `This file is ${formatBytes(bytes)}; the limit is ${formatBytes(MEDIA_LIMITS.maxFileBytes)}.`,
    );
  }
}

export function assertImagePixels(width: number, height: number): void {
  if (width * height > MEDIA_LIMITS.maxImagePixels) {
    const mp = (n: number) => Math.round(n / 1e6);
    throw new MediaError(
      'too-large',
      `This image is ${width} × ${height} (${mp(width * height)} megapixels); the limit is ` +
        `${mp(MEDIA_LIMITS.maxImagePixels)} megapixels. Resize it and try again.`,
    );
  }
}

export function assertAnimationLimits(width: number, height: number, frames: number): void {
  assertImagePixels(width, height);
  if (frames > MEDIA_LIMITS.maxAnimationFrames) {
    throw new MediaError(
      'too-large',
      `This animation has ${frames.toLocaleString('en-US')} frames; the limit is ` +
        `${MEDIA_LIMITS.maxAnimationFrames.toLocaleString('en-US')}. Trim it and try again.`,
    );
  }
}

export function assertVideoDuration(seconds: number): void {
  if (seconds > MEDIA_LIMITS.maxVideoSeconds) {
    throw new MediaError(
      'too-large',
      `This video is ${formatMinutes(seconds)} long; the limit is ${formatMinutes(MEDIA_LIMITS.maxVideoSeconds)}. ` +
        'Trim it and try again.',
    );
  }
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${+gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatMinutes(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
