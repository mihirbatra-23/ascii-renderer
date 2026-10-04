/**
 * Real frame timestamps of a video, for frame-exact stepping on variable-frame-rate clips: the
 * average frame rate puts 1/fps steps on repeated or skipped pictures when frames are unevenly
 * spaced (a 54 fps phone clip on a 120 Hz timebase stepped wrongly 14 times in 60).
 */

/** Media times are compared with this tolerance (containers and the element round differently). */
const EPSILON_SEC = 1e-4;

/**
 * Presentation time (s) of every frame of the primary video track, ascending. Reads packet metadata
 * only (no decoding): a few ms for MP4, one pass over the clusters for WebM. Null when the container
 * cannot be read.
 */
export async function readFrameTimes(file: Blob): Promise<Float64Array | null> {
  const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const times: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      times.push(packet.timestamp);
    }
    // Packets come in decode order; B-frames make that differ from presentation order.
    return times.length > 0 ? Float64Array.from(times).sort() : null;
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

/** Index of the frame on screen at `timeSec` (the last one starting at or before it; 0 before the first). */
export function frameIndexAtTime(times: Float64Array, timeSec: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= timeSec + EPSILON_SEC) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A seek target safely inside frame `index`: the middle of its display interval, so neither the
 * container's nor the element's timestamp rounding can land on a neighbour. The last frame lasts
 * until `durationSec`.
 */
export function frameMidTime(times: Float64Array, index: number, durationSec: number): number {
  const i = Math.max(0, Math.min(times.length - 1, index));
  const end = i + 1 < times.length ? times[i + 1] : Math.max(times[i] + EPSILON_SEC, durationSec);
  return (times[i] + end) / 2;
}

/**
 * The frame `frames` steps away from the one on screen at `timeSec`, kept to the frames visible in
 * the trim range [inSec, outSec).
 */
export function stepFrameIndex(times: Float64Array, timeSec: number, frames: number, inSec: number, outSec: number): number {
  const first = frameIndexAtTime(times, inSec);
  const last = Math.max(first, frameIndexAtTime(times, outSec - 2 * EPSILON_SEC));
  const from = frameIndexAtTime(times, timeSec);
  return Math.max(first, Math.min(last, from + Math.trunc(frames)));
}
