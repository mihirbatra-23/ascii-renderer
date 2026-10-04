/**
 * What a video export does with the source's audio, decided once for both the export and the
 * Export panel's "Include audio" label, so the two never disagree.
 *
 * MP4 keeps AAC and MP3 as they are; anything else (Opus from a WebM, Vorbis, FLAC) plays in
 * browsers but not in many editors and players, so it is converted to AAC. WebM only holds Opus
 * and Vorbis; other codecs are converted to Opus.
 */
import type { AudioCodec, ConversionAudioOptions, InputAudioTrack } from 'mediabunny';
import type { LoadedVideo } from '../media/types';
import { loadMediabunny, type VideoContainer } from './video-codecs';

export interface AudioPlan {
  /** copy: the source packets go in unchanged; transcode: re-encoded to `to`; none: the file has no audio. */
  action: 'copy' | 'transcode' | 'none';
  /** The source track's codec ('AAC', 'Opus', …). */
  from?: string;
  /** The audio codec in the exported file. */
  to?: string;
  /** A note for the export's warnings when the audio is not simply copied. */
  note?: string;
}

const MP4_SAFE: ReadonlySet<string> = new Set(['aac', 'mp3']);
const WEBM_NATIVE: ReadonlySet<string> = new Set(['opus', 'vorbis']);
const LABEL: Record<string, string> = { aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC' };

function audioLabel(codec: string | null): string {
  return codec ? (LABEL[codec] ?? codec.toUpperCase()) : 'unknown audio';
}

type CanEncode = (codec: AudioCodec, options: { numberOfChannels: number; sampleRate: number }) => Promise<boolean>;

/** The plan for one source track (`codec` null when its codec is unknown) and the Mediabunny options that carry it out. */
export async function planAudio(
  track: Pick<InputAudioTrack, 'codec' | 'numberOfChannels' | 'sampleRate'>,
  container: VideoContainer,
  canEncode: CanEncode,
): Promise<{ plan: AudioPlan; options: ConversionAudioOptions }> {
  const { codec } = track;
  const from = audioLabel(codec);
  const format = { numberOfChannels: track.numberOfChannels, sampleRate: track.sampleRate };
  const copy = (note?: string) => ({ plan: { action: 'copy' as const, from, to: from, note }, options: {} });
  if (container === 'mp4') {
    if (codec && MP4_SAFE.has(codec)) return copy();
    if (await canEncode('aac', format)) {
      const note = `Audio converted from ${from} to AAC so the MP4 plays everywhere.`;
      return { plan: { action: 'transcode', from, to: 'AAC', note }, options: { codec: 'aac', forceTranscode: true } };
    }
    return copy(`Audio kept as ${from}: some players and editors can’t play it in an MP4. Export WebM if that matters.`);
  }
  if (codec && WEBM_NATIVE.has(codec)) return copy();
  if (await canEncode('opus', format)) {
    const note = `Audio converted from ${from} to Opus (WebM can’t hold ${from}).`;
    return { plan: { action: 'transcode', from, to: 'Opus', note }, options: { codec: 'opus' } };
  }
  return { plan: { action: 'none', from, note: 'Audio not included: this browser can’t encode audio for WebM.' }, options: { discard: true } };
}

/** What exporting `video` as `format` will do with its audio (the Export panel's "Include audio" label). */
export async function exportAudioPlan(video: LoadedVideo, format: VideoContainer): Promise<AudioPlan> {
  if (!video.hasAudio || video.live) return { action: 'none' };
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(video.file), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { action: 'none' };
    return (await planAudio(track, format, mb.canEncodeAudio)).plan;
  } finally {
    input.dispose();
  }
}
