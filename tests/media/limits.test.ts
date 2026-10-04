import { describe, expect, it } from 'vitest';
import { assertAnimationLimits, assertFileSize, assertImagePixels, assertVideoDuration } from '../../src/media/limits';
import { MEDIA_LIMITS, MediaError } from '../../src/media/types';

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof MediaError ? error.code : 'not a MediaError';
  }
}

describe('limits', () => {
  it('rejects empty and oversized files', () => {
    expect(codeOf(() => assertFileSize(0))).toBe('empty-file');
    expect(codeOf(() => assertFileSize(1))).toBeNull();
    expect(codeOf(() => assertFileSize(MEDIA_LIMITS.maxFileBytes + 1))).toBe('too-large');
  });

  it('rejects images over the pixel budget with a readable message', () => {
    expect(codeOf(() => assertImagePixels(10_000, 10_000))).toBeNull();
    expect(() => assertImagePixels(12_000, 9_000)).toThrow(/12000 × 9000 \(108 megapixels\); the limit is 100 megapixels/);
  });

  it('rejects animations over the frame budget (never truncates)', () => {
    expect(codeOf(() => assertAnimationLimits(100, 100, MEDIA_LIMITS.maxAnimationFrames))).toBeNull();
    expect(() => assertAnimationLimits(100, 100, 2001)).toThrow(/2,001 frames; the limit is 2,000/);
  });

  it('rejects long videos', () => {
    expect(codeOf(() => assertVideoDuration(600))).toBeNull();
    expect(() => assertVideoDuration(725)).toThrow(/12 min 5 s long; the limit is 10 min/);
  });
});
