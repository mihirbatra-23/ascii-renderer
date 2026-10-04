/**
 * Render-parameter metadata for the UI: app defaults, numeric ranges and formatting
 * for sliders / value fields, dock sections (for "Reset section"), built-in presets and a
 * sanitiser for persisted values.
 */
import {
  DEFAULT_PARAMS,
  type CharsetPreset,
  type ColorMode,
  type DitherPattern,
  type FontId,
  type HalftoneShape,
  type RenderMode,
  type RenderParams,
} from '../engine/types';
import { MAX_GLYPHS } from '../engine/charsets';

export type ParamKey = keyof RenderParams;
export type NumericParamKey = {
  [K in ParamKey]: RenderParams[K] extends number ? K : never;
}[ParamKey];

/** In on-screen order (mode tiles, the M shortcut cycle). */
export const RENDER_MODES: readonly RenderMode[] = ['shape', 'ramp', 'braille', 'halftone', 'blocks'];
export const COLOR_MODES: readonly ColorMode[] = ['mono', 'source', 'duotone'];

/**
 * Render ink / paper: the swatch defaults the GPU draws with (tokens.css --ink*, --paper).
 * Duotone colours a cell mix(shadowInk, ink, smoothstep(tone)), so a dark cell is both sparse and
 * dim. The shadow ink is lifted from the boards' #5C5953 so low-key photos keep their shadows
 * (+15% displayed light on big_sur / terrain, still clearly two-tone; #8A867E all but
 * matched Mono and lost the duotone character).
 */
const DEFAULT_COLORS: Pick<RenderParams, 'ink' | 'shadowInk' | 'paper'> = { ink: '#e6e4df', shadowInk: '#747069', paper: '#0b0b0c' };

/** The app's starting look: Geist Mono, Duotone in the default ink (design spec §4.2). */
export function defaultParams(): RenderParams {
  return { ...DEFAULT_PARAMS, font: 'geist-mono', colorMode: 'duotone', ...DEFAULT_COLORS };
}

export interface NumericSpec {
  min: number;
  max: number;
  /** Value granularity (rounding for typed / scrubbed values). */
  step: number;
  /** Bipolar sliders fill out from the centre detent. */
  bipolar?: boolean;
  format: (v: number) => string;
}

const fixed = (digits: number) => (v: number) => v.toFixed(digits);
const signed = (digits: number) => (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);

export const NUMERIC_SPECS: Record<NumericParamKey, NumericSpec> = {
  columns: { min: 40, max: 400, step: 1, format: (v) => String(Math.round(v)) },
  brightness: { min: -0.5, max: 0.5, step: 0.01, bipolar: true, format: signed(2) },
  contrast: { min: 0.5, max: 2, step: 0.01, format: fixed(2) },
  gamma: { min: 0.4, max: 2.5, step: 0.01, format: fixed(2) },
  shapeSharpness: { min: 1, max: 4, step: 0.05, format: fixed(2) },
  edgeSharpness: { min: 1, max: 4, step: 0.05, format: fixed(2) },
  dither: { min: 0, max: 0.5, step: 0.01, format: fixed(2) },
  halftoneAngle: { min: 0, max: 90, step: 1, format: (v) => `${Math.round(v)}°` },
  lineHeight: { min: 1, max: 1.6, step: 0.05, format: fixed(2) },
  stability: { min: 0, max: 1, step: 0.01, format: fixed(2) },
  edgeThreshold: { min: 0, max: 1, step: 0.01, format: fixed(2) },
};

/** What each parameter is called on screen (dock labels), for announcements such as "Undone: Contrast". */
export const PARAM_LABELS: Record<ParamKey, string> = {
  mode: 'Mode',
  columns: 'Columns',
  charsetPreset: 'Glyph set',
  customCharset: 'Custom glyphs',
  font: 'Font',
  lineHeight: 'Line height',
  autoLevels: 'Auto levels',
  brightness: 'Brightness',
  contrast: 'Contrast',
  gamma: 'Gamma',
  invert: 'Invert',
  shapeSharpness: 'Shape contrast',
  edgeSharpness: 'Edge sharpness',
  dither: 'Dither',
  ditherPattern: 'Dither',
  halftoneAngle: 'Dot angle',
  halftoneShape: 'Dot shape',
  colorMode: 'Color mode',
  ink: 'Ink',
  paper: 'Paper',
  shadowInk: 'Shadow',
  stability: 'Stability',
  edges: 'Contour lines',
  edgeThreshold: 'Edge threshold',
};

/** Parameters grouped the way the dock groups them; resetParams(section) restores one group. */
export const PARAM_SECTIONS = {
  grid: ['columns'],
  tone: ['brightness', 'contrast', 'gamma', 'invert', 'autoLevels', 'edgeSharpness', 'dither'],
  glyphs: ['charsetPreset', 'customCharset'],
  color: ['colorMode', 'ink', 'shadowInk', 'paper'],
  edges: ['edges', 'edgeThreshold'],
  motion: ['stability'],
  advanced: ['font', 'lineHeight', 'shapeSharpness', 'ditherPattern', 'halftoneAngle', 'halftoneShape'],
} as const satisfies Record<string, readonly ParamKey[]>;

export type ParamSection = keyof typeof PARAM_SECTIONS;

/**
 * Built-in looks. Each overrides only what defines it; everything else keeps the user's values.
 * Tuned on a test corpus (torus, planet, aerial, sonoma, macblue, line art):
 *
 *   Line art        contour strokes from the edge layer over a fill of dots, so outlines read as
 *                   line art (the 'lines' glyph set alone filled bright areas with | walls)
 *   Soft photo      Ramp over the evenly stepped short set: smooth tone; full ASCII in Ramp is
 *                   letter noise, and dither above 0.08 printed a dot lattice over black
 *   Braille dots    contrast 1.1: at 1.2 ⣿ filled 30% of a sunlit photo and blew the highlights
 */
export const BUILTIN_PRESETS: readonly { name: string; params: Partial<RenderParams> }[] = [
  {
    name: 'Line art',
    params: { mode: 'ramp', charsetPreset: 'custom', customCharset: ' .:', contrast: 1.1, gamma: 1.2, dither: 0, edges: true, edgeThreshold: 0.3 },
  },
  {
    name: 'Soft photo',
    params: { mode: 'ramp', charsetPreset: 'minimal', contrast: 1.1, gamma: 0.9, dither: 0.06, edges: false, colorMode: 'duotone' },
  },
  { name: 'Braille dots', params: { mode: 'braille', ditherPattern: 'noise', contrast: 1.1, gamma: 0.9 } },
  {
    name: 'Halftone print',
    params: { mode: 'halftone', halftoneShape: 'round', halftoneAngle: 45, contrast: 1.15, colorMode: 'duotone' },
  },
  { name: 'Teletext', params: { mode: 'blocks', columns: 80, ditherPattern: 'ordered', colorMode: 'source', contrast: 1.2 } },
];

const ENUMS: Partial<Record<ParamKey, readonly string[]>> = {
  mode: RENDER_MODES,
  colorMode: COLOR_MODES,
  charsetPreset: ['ascii', 'minimal', 'dense', 'lines', 'custom'] satisfies CharsetPreset[],
  font: ['jetbrains-mono', 'ibm-plex-mono', 'geist-mono'] satisfies FontId[],
  ditherPattern: ['none', 'ordered', 'noise'] satisfies DitherPattern[],
  halftoneShape: ['round', 'square', 'diamond', 'line'] satisfies HalftoneShape[],
};

const HEX = /^#[0-9a-f]{6}$/i;

export function clampParam(key: NumericParamKey, value: number): number {
  const spec = NUMERIC_SPECS[key];
  const v = Math.min(spec.max, Math.max(spec.min, value));
  // toFixed strips float noise such as 0.30000000000000004 from the step multiplication.
  const decimals = (String(spec.step).split('.')[1] ?? '').length;
  return Number((Math.round(v / spec.step) * spec.step).toFixed(decimals));
}

/**
 * A custom glyph set longer than this cannot add glyphs (the engine keeps at most MAX_GLYPHS distinct
 * ones), so stored or linked text beyond it is dropped rather than kept around.
 */
const MAX_CUSTOM_CHARSET = 4 * MAX_GLYPHS;

/**
 * Keep only well-typed, in-range values from untrusted input (localStorage, user presets, settings
 * links), falling back to `base` for anything else.
 */
export function sanitizeParams(input: unknown, base: RenderParams): RenderParams {
  const out: RenderParams = { ...base };
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as ParamKey[]) {
    const v = src[key];
    if (typeof v !== typeof base[key]) continue;
    if (typeof v === 'number') {
      // Every numeric parameter has a spec (NUMERIC_SPECS is keyed by NumericParamKey).
      if (Number.isFinite(v)) target[key] = clampParam(key as NumericParamKey, v);
    } else if (typeof v === 'string') {
      if (key === 'customCharset') target[key] = Array.from(v).slice(0, MAX_CUSTOM_CHARSET).join('');
      else if (ENUMS[key]) {
        if (ENUMS[key].includes(v)) target[key] = v;
      } else if (HEX.test(v)) target[key] = v.toLowerCase();
    } else {
      target[key] = v;
    }
  }
  return out;
}

export function paramsEqual(a: RenderParams, b: RenderParams): boolean {
  for (const key of Object.keys(a) as ParamKey[]) if (a[key] !== b[key]) return false;
  return true;
}
