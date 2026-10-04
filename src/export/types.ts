/**
 * Export contracts. Every exporter is a projection of the engine's single grid + geometry,
 * so exports are pixel/character-identical to the preview by construction.
 */

export type StillFormat = 'png' | 'svg' | 'txt' | 'html';
export type AnimatedFormat = 'gif' | 'mp4' | 'webm';
export type ExportFormat = StillFormat | AnimatedFormat;

export interface ExportOptions {
  format: ExportFormat;
  /** Integer raster scale (PNG / GIF / video). */
  scale: number;
  /**
   * Exact output width in px (overrides scale): rendered at the next integer scale and resampled with a
   * high-quality filter; height follows the grid aspect (rounded), so the aspect is kept to within 0.5 px.
   */
  targetWidth?: number;
  /** Margin in scale-1 px around the grid. */
  margin: number;
  /** PNG / WebM / SVG: keep the paper transparent. */
  transparentBackground: boolean;
  /** TXT */
  lineEnding: '\n' | '\r\n';
  /** SVG: glyph outlines as <path> (pastes cleanly into Figma) vs live <text>. */
  svgText: 'outlines' | 'text';
  /** Animated: trim range in seconds and output frame rate (video defaults to source fps, GIF to ≤ 25). */
  startSec?: number;
  endSec?: number;
  fps?: number;
  /** Video: keep the source audio track (copied without re-encoding when possible). */
  includeAudio: boolean;
}

export interface ExportProgress {
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  /** e.g. 'Encoding frame 41 / 150'. */
  label: string;
  /** Seconds remaining estimate, when known. */
  etaSec?: number;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** Output pixel size for raster formats. */
  width?: number;
  height?: number;
  /** Notes to surface to the user (e.g. 'Audio not included: codec could not be copied'). */
  warnings: string[];
}

/** What the export sheet shows before the user commits. */
export interface ExportEstimate {
  width?: number;
  height?: number;
  frames?: number;
  /** Rough byte estimate, when cheap to compute. */
  bytes?: number;
  /** When the sampled frames disagree a lot (a GIF whose motion varies over the clip): low and high bounds around `bytes`. */
  bytesRange?: [number, number];
  /** e.g. 'Exceeds this device's maximum canvas size; will be rendered in tiles.' */
  notes: string[];
  supported: boolean;
}
