import type { OutputFormat } from 'mediabunny';

/** Mediabunny is imported on demand so it stays out of the app's initial bundle. */
export type Mediabunny = typeof import('mediabunny');
export const loadMediabunny = (): Promise<Mediabunny> => import('mediabunny');

export type VideoContainer = 'mp4' | 'webm';
export type VideoCodecChoice = 'avc' | 'vp9' | 'av1' | 'vp8';

export interface VideoTarget {
  container: VideoContainer;
  codec: VideoCodecChoice;
}

const LABEL: Record<VideoCodecChoice, string> = { avc: 'H.264', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };

/** Preference order per requested format: MP4 falls back to WebM rather than an exotic MP4 codec. */
const CANDIDATES: Record<VideoContainer, VideoTarget[]> = {
  mp4: [
    { container: 'mp4', codec: 'avc' },
    { container: 'webm', codec: 'vp9' },
    { container: 'webm', codec: 'av1' },
  ],
  webm: [
    { container: 'webm', codec: 'vp9' },
    { container: 'webm', codec: 'av1' },
    { container: 'webm', codec: 'vp8' },
  ],
};

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export function targetLabel(target: VideoTarget): string {
  return `${target.container === 'mp4' ? 'MP4' : 'WebM'} (${LABEL[target.codec]})`;
}

export function outputFormat(mb: Mediabunny, container: VideoContainer): OutputFormat {
  return container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
}

export interface TargetChoice {
  target: VideoTarget;
  /** Set when the requested format/codec was not encodable and a fallback was chosen. */
  warning?: string;
}

/**
 * First encodable target for the requested format at this exact size (encoders have size limits,
 * e.g. many H.264 encoders stop at 4096 px). Null when nothing can be encoded with WebCodecs.
 */
export async function chooseVideoTarget(
  format: VideoContainer,
  width: number,
  height: number,
  alpha = false,
): Promise<TargetChoice | null> {
  if (!hasWebCodecs()) return null;
  const { canEncodeVideo } = await loadMediabunny();
  const candidates = CANDIDATES[format];
  for (const target of candidates) {
    const keepAlpha = alpha && target.container === 'webm';
    const ok = await canEncodeVideo(target.codec, { width, height, ...(keepAlpha ? { alpha: 'keep' as const } : {}) }).catch(
      () => false,
    );
    if (!ok) continue;
    if (target === candidates[0]) return { target };
    return {
      target,
      warning: `${targetLabel(candidates[0])} isn’t available in this browser at ${width} × ${height}; saved as ${targetLabel(target)} instead.`,
    };
  }
  return null;
}
