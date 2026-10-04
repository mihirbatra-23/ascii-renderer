/**
 * Glyph drawing and glyph shape vectors (docs/ALGORITHM.md §1, §4).
 *
 * Public API
 *   GlyphContext, CanvasFactory   the minimal 2D-context surface the engine draws with, so the same
 *                                 code runs on DOM / OffscreenCanvas and on @napi-rs/canvas in Node
 *   drawGlyph(ctx, ch, penX, baselineY, fontSizePx, family)
 *                                 THE canonical glyph draw: pen at penX, alphabetic baseline at
 *                                 baselineY, left aligned, no kerning, letterSpacing 0. Every raster
 *                                 path (atlas tiles, previews, exports) must draw text through it.
 *   buildGlyphSet(chars, geometry, factory, taps) → GlyphSet (normalised shape vectors, anchor W,
 *                                 plus the edge layer's stroke glyphs)
 */
import type { CellGeometry } from './types';
import type { TapTables } from './layout';
import { EDGE_STROKES, EdgeStroke } from './charsets';

export interface GlyphTextMetrics {
  width: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

export interface GlyphContext {
  font: string;
  /** Typed loosely so DOM, OffscreenCanvas and @napi-rs/canvas contexts all fit. */
  fillStyle: string | object;
  textAlign: string;
  textBaseline: string;
  letterSpacing?: string;
  fontKerning?: string;
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  clip(): void;
  save(): void;
  restore(): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: Uint8ClampedArray };
  measureText(text: string): GlyphTextMetrics;
}

/** Creates a w × h canvas with a 2D context (e.g. `document.createElement('canvas')` or `createCanvas` from @napi-rs/canvas). */
export type CanvasFactory = (width: number, height: number) => { canvas: unknown; ctx: GlyphContext };

interface FontState {
  requested: string;
  readBack: string;
}

// Assigning ctx.font re-parses the font string; skip it while the context still holds our font.
const fontStates = new WeakMap<GlyphContext, FontState>();

export function drawGlyph(
  ctx: GlyphContext,
  ch: string,
  penX: number,
  baselineY: number,
  fontSizePx: number,
  family: string,
): void {
  const font = `${fontSizePx}px ${family}`;
  const state = fontStates.get(ctx);
  if (!state || state.requested !== font || state.readBack !== ctx.font) {
    ctx.font = font;
    fontStates.set(ctx, { requested: font, readBack: ctx.font });
  }
  if (ctx.textAlign !== 'left') ctx.textAlign = 'left';
  if (ctx.textBaseline !== 'alphabetic') ctx.textBaseline = 'alphabetic';
  if (ctx.letterSpacing !== undefined && ctx.letterSpacing !== '0px') ctx.letterSpacing = '0px';
  if (ctx.fontKerning !== undefined && ctx.fontKerning !== 'none') ctx.fontKerning = 'none';
  ctx.fillText(ch, penX, baselineY);
}

export interface GlyphSet {
  /** Matchable glyphs; chars[0] is the space. */
  chars: string[];
  /** n × 6 internal-circle coverages, each component divided by its maximum over the set. */
  vectors: Float32Array;
  /** The per-component maxima of the raw coverages (the normaliser of `vectors`). */
  componentMax: Float64Array;
  /** White-point anchor W = max over glyphs of the mean normalised component. */
  anchor: number;
  /** Mean normalised component per glyph (ramp mode's tone axis). */
  meanCoverage: Float32Array;
  /** Ramp mode's candidates: indices into `chars`, ascending (every glyph unless a ramp subset was given). */
  rampGlyphs: Uint16Array;
  /** Ramp mode's white point: the largest mean coverage among rampGlyphs (≤ anchor). */
  rampAnchor: number;
  /** Requested characters left out: not in the font, no ink, or a duplicate shape. */
  dropped: string[];
  /**
   * Every drawable glyph: `chars` (the matchable ones, same indices) followed by the edge strokes
   * the charset lacks. Grid indices of shape / ramp cells index this list.
   */
  atlasChars: string[];
  /** Index into atlasChars of each EDGE_STROKES glyph (§5b). */
  strokes: Uint16Array;
  /**
   * Horizontal edges whose weighted centre lies below this fraction of the cell height become '_',
   * higher ones '-': halfway between the two glyphs' ink centres in this font and cell.
   */
  lowStrokeSplit: number;
}

const SUPERSAMPLE = 4;
const DEDUPE_EPS = 1e-3;
const ADVANCE_TOLERANCE = 1e-3;
/** Plane-16 private use: no font maps it, so it renders as the platform's missing-glyph symbol. */
const TOFU = '\u{10FFFD}';

function alphaOf(ctx: GlyphContext, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3];
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Rasterise every candidate into a 4×-supersampled tile with the §1 geometry scaled to the tile,
 * area-downsample to SW × SH coverage, sample it with the same internal tap tables as images,
 * then normalise per component and dedupe.
 */
export function buildGlyphSet(
  chars: readonly string[],
  geometry: CellGeometry,
  factory: CanvasFactory,
  taps: TapTables,
  /** Ramp mode's glyphs (charsets.ts rampCharset); undefined = all. Ignored if the font has fewer than two of them. */
  rampChars?: readonly string[],
): GlyphSet {
  const { sw, sh } = taps;
  const tileW = sw * SUPERSAMPLE;
  const tileH = sh * SUPERSAMPLE;
  const fontSize = (geometry.fontSize * tileW) / geometry.cellW;
  const baseline = (geometry.baseline * tileH) / geometry.cellH;
  const family = geometry.fontFamily;
  const { ctx } = factory(tileW, tileH);

  const render = (ch: string, fam: string) => {
    ctx.clearRect(0, 0, tileW, tileH);
    ctx.fillStyle = '#fff';
    drawGlyph(ctx, ch, 0, baseline, fontSize, fam);
    return alphaOf(ctx, tileW, tileH);
  };
  const tofu = render(TOFU, family);
  const expectedAdvance = fontSize * geometry.advanceEm;

  // A glyph the font lacks is either drawn as the missing-glyph box (canvases without fallback)
  // or by a fallback font, which shows up as a different advance or as a rendering that depends
  // on the generic family appended to the stack. Called right after render(ch, family), so
  // ctx.font is still the bundled font when measuring.
  const inFont = (ch: string, alpha: Uint8Array) => {
    if (sameBytes(alpha, tofu)) return false;
    if (Math.abs(ctx.measureText(ch).width - expectedAdvance) > ADVANCE_TOLERANCE * expectedAdvance) return false;
    return sameBytes(render(ch, `${family}, serif`), render(ch, `${family}, monospace`));
  };

  const kept: string[] = [];
  const raw: number[][] = [];
  const dropped: string[] = [];
  const coverage = new Float64Array(sw * sh);
  const area = 1 / (SUPERSAMPLE * SUPERSAMPLE * 255);
  for (const ch of chars) {
    const alpha = ch === ' ' ? null : render(ch, family);
    if (alpha && !inFont(ch, alpha)) {
      dropped.push(ch);
      continue;
    }
    coverage.fill(0);
    let ink = 0;
    if (alpha) {
      for (let y = 0; y < tileH; y++) {
        const row = ((y / SUPERSAMPLE) | 0) * sw;
        for (let x = 0; x < tileW; x++) {
          const a = alpha[y * tileW + x];
          coverage[row + ((x / SUPERSAMPLE) | 0)] += a * area;
          ink += a;
        }
      }
      if (ink === 0) {
        dropped.push(ch);
        continue;
      }
    }
    kept.push(ch);
    raw.push(
      taps.internal.map((t) => {
        let s = 0;
        for (let i = 0; i < t.w.length; i++) s += t.w[i] * coverage[t.dy[i] * sw + t.dx[i]];
        return s;
      }),
    );
  }

  const componentMax = new Float64Array(6);
  for (const v of raw) for (let k = 0; k < 6; k++) componentMax[k] = Math.max(componentMax[k], v[k]);
  for (let k = 0; k < 6; k++) if (componentMax[k] <= 0) componentMax[k] = 1;

  const outChars: string[] = [];
  const vecs: number[] = [];
  raw.forEach((v, g) => {
    const norm = v.map((x, k) => x / componentMax[k]);
    for (let o = 0; o < vecs.length; o += 6) {
      let d2 = 0;
      for (let k = 0; k < 6; k++) d2 += (vecs[o + k] - norm[k]) ** 2;
      if (d2 <= DEDUPE_EPS * DEDUPE_EPS) {
        dropped.push(kept[g]);
        return;
      }
    }
    outChars.push(kept[g]);
    vecs.push(...norm);
  });

  const vectors = Float32Array.from(vecs);
  const meanCoverage = new Float32Array(outChars.length);
  let anchor = 0;
  for (let g = 0; g < outChars.length; g++) {
    let s = 0;
    for (let k = 0; k < 6; k++) s += vectors[g * 6 + k];
    meanCoverage[g] = s / 6;
    anchor = Math.max(anchor, meanCoverage[g]);
  }

  const inRamp = (ch: string) => ch === ' ' || !rampChars || rampChars.includes(ch);
  let rampList = outChars.flatMap((ch, g) => (inRamp(ch) ? [g] : []));
  if (rampList.length < 2) rampList = outChars.map((_, g) => g);
  const rampGlyphs = Uint16Array.from(rampList);
  const rampAnchor = Math.max(...Array.from(rampGlyphs, (g) => meanCoverage[g])) || 1;

  const atlasChars = [...outChars];
  const strokes = Uint16Array.from(EDGE_STROKES, (c) => {
    const i = atlasChars.indexOf(c);
    if (i >= 0) return i;
    atlasChars.push(c);
    return atlasChars.length - 1;
  });
  // Vertical ink centre of a glyph as a fraction of the cell height.
  const inkCentre = (ch: string) => {
    const alpha = render(ch, family);
    let sum = 0;
    let moment = 0;
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        sum += alpha[y * tileW + x];
        moment += alpha[y * tileW + x] * (y + 0.5);
      }
    }
    return moment / Math.max(sum, 1) / tileH;
  };
  const lowStrokeSplit = (inkCentre(EDGE_STROKES[EdgeStroke.horizontal]) + inkCentre(EDGE_STROKES[EdgeStroke.low])) / 2;
  return { chars: outChars, vectors, componentMax, anchor: anchor || 1, meanCoverage, rampGlyphs, rampAnchor, dropped, atlasChars, strokes, lowStrokeSplit };
}
