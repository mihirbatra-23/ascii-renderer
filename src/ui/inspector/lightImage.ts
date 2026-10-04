/**
 * The "light image" check behind Tone's Invert hint. With light ink on dark paper a
 * mostly white image (line art, a scan, a screenshot) maps its white paper to the densest
 * glyphs, so the drawing only shows as gaps in a wall of '$'. Invert draws the dark strokes
 * instead. The same holds for a mostly dark image on light paper.
 *
 * The measure is the image as the engine maps it (docs/ALGORITHM.md §3: the same tone code on the
 * same ≤ 256 px area-filtered downsample auto-levels use): the median ink coverage over every
 * pixel, with transparent pixels as paper. So a light logo on a transparent background, whose
 * visible pixels are all white, does not count: most of its area is paper.
 *
 *   sampleLumaAlpha(rgba, w, h)       the downsample, once per image
 *   medianInk(sample, params, levels) cheap enough to redo on every tone change
 *
 * Calibrated on a test corpus and the test fixtures at the default look: line art and text scans
 * measure 0.996–1.0 (their white paper saturates after auto-levels), photographs 0.0–0.72, the
 * brightest graphic 0.88, transparent logos 0. The threshold sits in that gap: more than half of
 * the picture would be the densest glyph.
 */
import { hexLuma } from '../../engine/color';
import { resampleLumaAlpha } from '../../engine/resample';
import { toneConstants, toneMapPlane } from '../../engine/tone';
import type { Levels, RenderParams } from '../../engine/types';

/** Median ink coverage at or above this suggests Invert. */
export const LIGHT_IMAGE_MEDIAN = 0.95;

const MAX_EDGE = 256;

/** Interleaved (luma × alpha, alpha) pairs of a ≤ 256 px downsample. */
export interface LumaAlphaSample {
  la: Float32Array;
  pixels: number;
}

export function sampleLumaAlpha(rgba: ArrayLike<number>, width: number, height: number): LumaAlphaSample {
  const s = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  return { la: resampleLumaAlpha(rgba, width, height, w, h), pixels: w * h };
}

/** Histogram resolution of the median: far finer than any decision made with it. */
const BINS = 1024;

/** Median tone-mapped ink coverage 0..1 (1 = the densest glyph) under `params`. */
export function medianInk(sample: LumaAlphaSample, params: RenderParams, levels: Levels): number {
  const tones = toneMapPlane(sample.la, new Float32Array(sample.pixels), toneConstants(params, levels));
  // A histogram instead of a sort: this reruns while a tone slider is dragged.
  const counts = new Uint32Array(BINS);
  for (const t of tones) counts[Math.min(BINS - 1, Math.floor(t * BINS))]++;
  const half = sample.pixels / 2;
  let seen = 0;
  for (let bin = 0; bin < BINS; bin++) {
    seen += counts[bin];
    if (seen >= half) return (bin + 0.5) / BINS;
  }
  return 1;
}

/** What the Invert hint says, or null when the image does not need it. */
export function invertHint(medianInkCoverage: number, params: Pick<RenderParams, 'invert' | 'ink' | 'paper'>): 'light' | 'dark' | null {
  if (params.invert || medianInkCoverage < LIGHT_IMAGE_MEDIAN) return null;
  // Light ink inks the light parts of the image; dark ink the dark parts.
  return hexLuma(params.ink) > hexLuma(params.paper) ? 'light' : 'dark';
}
