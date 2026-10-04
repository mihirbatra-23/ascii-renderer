/**
 * Frame sources for animated exports, as async generators. A yielded frame stays valid until the
 * consumer asks for the next one (next() or return()), which releases it, so exporters render each
 * frame before requesting the next and never hold one across that call. Every source retains its
 * media while it runs: closing or replacing the file mid-export cannot break the export.
 */
import type { FrameSource, SourceInfo } from '../engine/types';
import type { LoadedAnimation, LoadedImage, LoadedVideo } from '../media/types';
import { ExportError } from './errors';
import { animationSpans, clampRange, spreadTimes, videoFrameTimes, type TimeRange } from './timing';

/** A frame to render for an animated export. */
export interface FrameInput {
  source: FrameSource;
  info: SourceInfo;
}

export interface ExportFrame extends FrameInput {
  /** How long this frame is shown in the output. */
  durationMs: number;
}

/** Frames of a sequential decode are matched to output times with this tolerance (s). */
const TIME_EPSILON = 1e-4;

/**
 * Animation frames inside the trim range, with their source delays (clipped at the range edges).
 * Frames are decoded for the export alone (LoadedAnimation.readFrame), so the preview's frame cache
 * is neither thrashed nor able to close a frame the export is rendering.
 */
export async function* animationFrames(anim: LoadedAnimation, range: TimeRange = {}): AsyncGenerator<ExportFrame> {
  const info: SourceInfo = { width: anim.width, height: anim.height, animated: true };
  const release = anim.retain();
  try {
    for (const [index, durationMs] of animationSpans(anim.durations, range)) {
      const frame = await anim.readFrame(index);
      try {
        yield { source: frame, info, durationMs };
      } finally {
        frame.close();
      }
    }
  } finally {
    release();
  }
}

/** Up to `count` frames spread evenly across the trim range (palette sampling). */
export async function* animationSamples(anim: LoadedAnimation, range: TimeRange = {}, count = 8): AsyncGenerator<FrameInput> {
  const spans = animationSpans(anim.durations, range);
  const info: SourceInfo = { width: anim.width, height: anim.height, animated: true };
  const n = Math.min(count, spans.length);
  const release = anim.retain();
  try {
    for (let k = 0; k < n; k++) {
      const [index] = spans[Math.floor(((k + 0.5) * spans.length) / n)];
      const frame = await anim.readFrame(index);
      try {
        yield { source: frame, info };
      } finally {
        frame.close();
      }
    }
  } finally {
    release();
  }
}

/** A still shown for `durationMs` (still → video / GIF). */
export async function* stillFrames(image: LoadedImage, durationMs: number): AsyncGenerator<ExportFrame> {
  const release = image.retain();
  try {
    yield { source: image.bitmap, info: { width: image.width, height: image.height, animated: false }, durationMs };
  } finally {
    release();
  }
}

/**
 * Video frames at a constant rate (video → GIF). The clip is decoded sequentially with Mediabunny,
 * and each output time shows the last source frame that starts at or before it, as a player would:
 * sequential decoding needs no seeking, so streaming-style WebMs without cues export completely
 * (timestamp lookups returned nothing past the first fraction of a second for those). Each frame
 * lasts 1/fps except the last, which is clipped to the end of the range; times before the first
 * source frame show that first frame.
 */
export async function* videoFrames(video: LoadedVideo, opts: TimeRange & { fps: number }): AsyncGenerator<ExportFrame> {
  const { start, end } = clampRange(opts, video.durationSec);
  const times = videoFrameTimes(video.durationSec, opts, opts.fps);
  if (times.length === 0) return;
  // Loaded on demand so Mediabunny stays out of the app's initial bundle.
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const release = video.retain();
  const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new ExportError('unsupported', 'This file has no video track.');
    const info: SourceInfo = { width: track.displayWidth, height: track.displayHeight, animated: true };
    // Three canvases: the frame on show, the next decoded one, and the one being decoded.
    const decoded = new CanvasSink(track, { poolSize: 3 }).canvases(start, end);
    let shown = false;
    for await (const [frame, t] of framesAtTimes(decoded, times)) {
      shown = true;
      yield { source: frame.canvas, info, durationMs: Math.min(1 / opts.fps, end - t) * 1000 };
    }
    if (!shown) throw new ExportError('empty', 'No frames could be read from this video.');
  } finally {
    input.dispose();
    release();
  }
}

/**
 * Resamples a stream of frames in presentation order to output `times` (ascending): yields, for each
 * time, the last frame that starts at or before it, i.e. what a player shows then (the first frame
 * for times before it, the last one for times after the stream ends). Looks one frame ahead, so a
 * yielded frame and the next one must both stay valid (a pool of three canvases is enough).
 */
export async function* framesAtTimes<T extends { timestamp: number }>(frames: AsyncIterable<T>, times: readonly number[]): AsyncGenerator<[T, number]> {
  const iterator = frames[Symbol.asyncIterator]();
  try {
    let current = (await iterator.next()).value as T | undefined;
    if (!current) return;
    let upcoming = (await iterator.next()).value as T | undefined;
    for (const t of times) {
      while (upcoming && upcoming.timestamp <= t + TIME_EPSILON) {
        current = upcoming;
        upcoming = (await iterator.next()).value as T | undefined;
      }
      yield [current, t];
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Up to `count` frames spread across the trim range of a video (palette sampling for video → GIF,
 * so colours that only appear later in the clip are in the palette). Times the decoder can't serve
 * are skipped.
 */
export async function* videoSamples(video: LoadedVideo, range: TimeRange = {}, count = 8): AsyncGenerator<FrameInput> {
  const times = spreadTimes(video.durationSec, range, count);
  if (times.length === 0) return;
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const release = video.retain();
  const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return;
    const info: SourceInfo = { width: track.displayWidth, height: track.displayHeight, animated: true };
    for await (const wrapped of new CanvasSink(track, { poolSize: 2 }).canvasesAtTimestamps(times)) {
      if (wrapped) yield { source: wrapped.canvas, info };
    }
  } finally {
    input.dispose();
    release();
  }
}
