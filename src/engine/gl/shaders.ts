/**
 * GLSL ES 3.00 sources for the engine's passes (docs/ALGORITHM.md). Every constant table (dither
 * matrices, braille bits, affecting sets, matcher and stability constants, edge kernels) is
 * generated from the engine core's TypeScript so the GPU cannot drift from the CPU reference.
 * Pass 2 exists twice per mode: uniform-driven (the sub-cell size and tap tables arrive as
 * uniforms, so it serves every font and line height without recompiling) and specialised for one
 * geometry (constants, about twice as fast), which the renderer swaps in once compiled.
 *
 * Public API
 *   FULLSCREEN_VS                 one oversized triangle; fragments address pixels by gl_FragCoord
 *   ProgramKey, PROGRAM_KEYS      every geometry-independent program (warmup compiles them all)
 *   specialisedCellKey(mode, sw, sh)  pass 2 compiled for one sub-cell size (faster; built in the background)
 *   fragmentSource(key)           the fragment shader of a program
 *   MAX_TAP_TABLES, MAX_TAPS      size of the `Taps` uniform block (data.ts packTaps; tables in
 *                                 TAP_TABLES order: 6 internal and 10 external circles, 8 dots, 4 quadrants)
 *   LIGHTNESS_MAX_FOOT, QUADRANT_MAX_FOOT, PRESENT_MAX_FOOT  above these reductions the
 *                                 resamplers read mip levels
 *   ComposeKind, composeKindOf(mode)
 */
import type { RenderMode } from '../types';
import { AFFECTS, buildRectTaps, buildTapTables, type TapTable } from '../layout';
import { BRAILLE_BITS, MAX_GLYPHS } from '../charsets';
import { bayer8 } from '../dither';
import { SHAPE_MIN, SHAPE_TAU } from '../match';
import { EDGE_COHERENCE, edgeKernels } from '../edges';

/** A GLSL float literal that round-trips the JS number. */
const glf = (v: number): string => {
  const s = String(v);
  return /[.e]/.test(s) ? s : `${s}.0`;
};

const BAYER8 = Array.from({ length: 64 }, (_, i) => glf(bayer8(i & 7, i >> 3))).join(', ');
const BRAILLE = BRAILLE_BITS.flat().join(', ');

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The separable resampler of src/engine/resample.ts on the GPU: exact box filter on a shrinking
 * axis, bilinear with half-pixel centres on an enlarging one, over the straight-alpha source,
 * premultiplied per texel. Large reductions read a mip level so a footprint never spans more than
 * MAX_FOOT texels per axis (level 0, i.e. exact, for any source up to MAX_FOOT× the target).
 */
const RESAMPLER = `
uniform sampler2D uSrc;
uniform ivec2 uDst;
uniform int uMaxLevel;

const int MAX_TAPS = MAX_FOOT + 2;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

struct Axis {
  int first;
  int count;
  float a;
  float b;
  float s;
  float f;
  bool box;
};

Axis axisTaps(int i, int src, int dst) {
  Axis ax;
  ax.s = float(src) / float(dst);
  ax.f = 0.0;
  ax.a = 0.0;
  ax.b = 0.0;
  if (ax.s >= 1.0) {
    ax.box = true;
    ax.a = float(i) * ax.s;
    ax.b = float(i + 1) * ax.s;
    ax.first = int(floor(ax.a));
    ax.count = min(src, int(ceil(ax.b))) - ax.first;
  } else {
    ax.box = false;
    float u = clamp((float(i) + 0.5) * ax.s - 0.5, 0.0, float(src - 1));
    ax.first = int(floor(u));
    ax.f = u - float(ax.first);
    ax.count = ax.f > 0.0 ? 2 : 1;
  }
  return ax;
}

float axisWeight(Axis ax, int k) {
  if (ax.box) {
    float j = float(ax.first + k);
    return max(0.0, min(ax.b, j + 1.0) - max(ax.a, j)) / ax.s;
  }
  return k == 0 ? 1.0 - ax.f : ax.f;
}

/** Area-resampled (premultiplied luma, premultiplied rgb, alpha) of target pixel p. */
void resample(ivec2 p, out float lum, out vec3 rgb, out float alpha) {
  int level = 0;
  ivec2 src = textureSize(uSrc, 0);
  while (level < uMaxLevel && (src.x > MAX_FOOT * uDst.x || src.y > MAX_FOOT * uDst.y)) {
    level++;
    src = textureSize(uSrc, level);
  }
  Axis ax = axisTaps(p.x, src.x, uDst.x);
  Axis ay = axisTaps(p.y, src.y, uDst.y);
  lum = 0.0;
  alpha = 0.0;
  rgb = vec3(0.0);
  for (int y = 0; y < MAX_TAPS; y++) {
    if (y >= ay.count) break;
    float wy = axisWeight(ay, y);
    for (int x = 0; x < MAX_TAPS; x++) {
      if (x >= ax.count) break;
      vec4 t = texelFetch(uSrc, ivec2(ax.first + x, ay.first + y), level);
      float wa = axisWeight(ax, x) * wy * t.a;
      lum += wa * dot(t.rgb, LUMA);
      rgb += wa * t.rgb;
      alpha += wa;
    }
  }
}
`;

/** Largest source footprint (texels per target pixel, per axis) the resamplers read at mip level 0. */
export const LIGHTNESS_MAX_FOOT = 16;
export const QUADRANT_MAX_FOOT = 16;
export const PRESENT_MAX_FOOT = 4;

/**
 * Pass 1: the analysis image (cols·SW × rows·SH): §3 tone per pixel. The visible (un-premultiplied)
 * luma is tone-mapped and the result scaled by alpha, so transparency is tone 0 (paper) under
 * any paper colour, levels, tone settings or Invert.
 */
const LIGHTNESS_FS = `${HEADER}
#define MAX_FOOT ${LIGHTNESS_MAX_FOOT}
${RESAMPLER}
uniform float uBlack;
uniform float uScale;
uniform float uContrast;
uniform float uBrightness;
uniform float uGamma;
uniform bool uInvert;

out float oL;

void main() {
  float lum;
  vec3 rgb;
  float alpha;
  resample(ivec2(gl_FragCoord.xy), lum, rgb, alpha);
  if (alpha <= 0.0) {
    oL = 0.0;
    return;
  }
  float l = clamp((lum / alpha - uBlack) * uScale, 0.0, 1.0);
  l = clamp((l - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
  if (uGamma != 1.0) l = l > 0.0 ? pow(l, uGamma) : 0.0;
  oL = alpha * (uInvert ? 1.0 - l : l);
}
`;

/**
 * Pass 1b: colour on the 2× cell grid (one pixel per block quadrant), straight from the source
 * like the CPU's quadrant colours, composited over the paper. Every mode's cell colour is the
 * mean of its four quadrants; blocks' two-colour fit uses them individually.
 */
const QUADRANT_FS = `${HEADER}
#define MAX_FOOT ${QUADRANT_MAX_FOOT}
${RESAMPLER}
uniform vec3 uPaper;

out vec4 oColour;

void main() {
  float lum;
  vec3 rgb;
  float alpha;
  resample(ivec2(gl_FragCoord.xy), lum, rgb, alpha);
  oColour = vec4(rgb + (1.0 - alpha) * uPaper, 1.0);
}
`;

/** Diagnostics: copies the source's level 0 texel for texel (what the passes read) into RGBA8. */
const COPY_SOURCE_FS = `${HEADER}
uniform sampler2D uSrc;
out vec4 oColour;

void main() {
  oColour = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
}
`;

// ------------------------------------------------------------------------------------------------
// §5b edge layer: the difference of Gaussians, separable, at analysis resolution.

const KERNEL = (() => {
  const { radius, g1, g2 } = edgeKernels();
  const list = (w: Float32Array) => Array.from(w, glf).join(', ');
  return `const int EDGE_R = ${radius};
const float G1[${radius + 1}] = float[${radius + 1}](${list(g1)});
const float G2[${radius + 1}] = float[${radius + 1}](${list(g2)});
`;
})();

/** Horizontal pass: both Gaussians of the analysis image, (G(σ)∗L, G(kσ)∗L) along x. */
const EDGE_BLUR_FS = `${HEADER}
${KERNEL}
uniform sampler2D uL;

out vec2 oBlur;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int last = textureSize(uL, 0).x - 1;
  float a = 0.0;
  float b = 0.0;
  for (int i = -EDGE_R; i <= EDGE_R; i++) {
    float v = texelFetch(uL, ivec2(clamp(p.x + i, 0, last), p.y), 0).r;
    int k = i < 0 ? -i : i;
    a += G1[k] * v;
    b += G2[k] * v;
  }
  oBlur = vec2(a, b);
}
`;

/** Vertical pass and difference: D = G(σ)∗L − G(kσ)∗L. */
const EDGE_DOG_FS = `${HEADER}
${KERNEL}
uniform sampler2D uBlur;

out float oD;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int last = textureSize(uBlur, 0).y - 1;
  float a = 0.0;
  float b = 0.0;
  for (int j = -EDGE_R; j <= EDGE_R; j++) {
    vec2 h = texelFetch(uBlur, ivec2(p.x, clamp(p.y + j, 0, last)), 0).rg;
    int k = j < 0 ? -j : j;
    a += G1[k] * h.x;
    b += G2[k] * h.y;
  }
  oD = a - b;
}
`;

// ------------------------------------------------------------------------------------------------
// Pass 2: one fragment per cell.

/** Tables in the `Taps` block: §2 circles, then the braille dots and block quadrants of §6. */
const TAP_TABLES = { internal: 0, external: 6, braille: 16, blocks: 24 } as const;
export const MAX_TAP_TABLES = 28;
/** Fits the 16 KB minimum uniform block with the ranges (SH ≤ 32 needs at most 878 taps). */
export const MAX_TAPS = 960;

/** Directional contrast (§5) unrolled from AFFECTS: q[k] sharpened against its external circles. */
const DIRECTIONAL = AFFECTS.map((ext, k) => {
  const m = ext.reduce((acc, j) => `max(${acc}, e[${j}])`, `q[${k}]`);
  return `    { float M = ${m}; if (M > 0.0) q[${k}] = pow(q[${k}] / M, uDirectional) * M; }`;
}).join('\n');

const CELL_COMMON = `
uniform sampler2D uL;
uniform sampler2D uQuads;
uniform sampler2D uNoise;
uniform sampler2D uPrevCell;
uniform sampler2D uPrevA;
uniform sampler2D uPrevB;
uniform ivec2 uImage;
uniform int uGlyphCount;
uniform float uAnchor;
uniform float uGlobal;
uniform float uDirectional;
uniform float uDither;
uniform float uStability;
uniform bool uHistory;
uniform float uBand;
uniform float uFitBand;
uniform int uPattern;
uniform bool uBlocksColour;

layout(location = 0) out vec4 oCell;
layout(location = 1) out vec4 oHistA;
layout(location = 2) out vec4 oHistB;

const float BAYER8[64] = float[64](${BAYER8});
const int BRAILLE[8] = int[8](${BRAILLE});

// Per glyph: (μ, ρ0, ρ1, ρ2), (ρ3, ρ4, ρ5, 0), read by every fragment alike, so a uniform buffer.
layout(std140) uniform Glyphs {
  vec4 uGlyphData[${MAX_GLYPHS * 2}];
};

ivec2 gCell;
ivec2 gBase;

/** Colour of quadrant i (TL, TR, BL, BR) of the current cell, over the paper. */
vec3 quadColour(int i) {
  return texelFetch(uQuads, gCell * 2 + ivec2(i & 1, i >> 1), 0).rgb;
}

/** Cell mean of the tone-mapped lightness, and the mean of the four quadrant colours. */
void cellMeans(out float tone, out vec3 colour) {
  float sl = 0.0;
  for (int y = 0; y < SH; y++) {
    for (int x = 0; x < SW; x++) sl += texelFetch(uL, gBase + ivec2(x, y), 0).r;
  }
  tone = sl * (1.0 / float(SW * SH));
  colour = (quadColour(0) + quadColour(1) + quadColour(2) + quadColour(3)) / 4.0;
}

/** §5 tone dither (dither.ts toneDither) with the cell's blue-noise value n. */
float toneDither(float t, float n) {
  return t + (n - 0.5) * max(0.0, min(min(uDither, 2.0 * t), 2.0 - 2.0 * t));
}

float cellNoise() {
  return texelFetch(uNoise, gCell & 63, 0).r;
}

/** §8 threshold shift (cpu.ts hysteresis): side −1 for a dot that was on, +1 off, 0 without history. */
float hysteresis(float t, int side) {
  return float(side) * min(uBand, min(t / 2.0, (1.0 - t) / 2.0));
}

float threshold(int x, int y) {
  if (uPattern == 1) return BAYER8[(y & 7) * 8 + (x & 7)];
  if (uPattern == 2) return texelFetch(uNoise, ivec2(x & 63, y & 63), 0).r;
  return 0.5;
}

float packRgb(vec3 c) {
  vec3 b = floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
  return b.r * 65536.0 + b.g * 256.0 + b.b;
}

// §8: previous frame's filtered features (a negative first component marks "no history").
vec4 gPrevA;
vec4 gPrevB;
int gPrevGlyph;
bool gPrevValid;

void loadHistory() {
  gPrevValid = false;
  gPrevGlyph = -1;
  if (!uHistory) return;
  gPrevA = texelFetch(uPrevA, gCell, 0);
  gPrevB = texelFetch(uPrevB, gCell, 0);
  gPrevValid = gPrevA.x >= 0.0;
  if (gPrevValid) gPrevGlyph = int(texelFetch(uPrevCell, gCell, 0).x);
}

void smoothFeatures(inout float v[8], int n) {
  if (!gPrevValid) return;
  float h[8] = float[8](gPrevA.x, gPrevA.y, gPrevA.z, gPrevA.w, gPrevB.x, gPrevB.y, gPrevB.z, gPrevB.w);
  float delta = 0.0;
  for (int k = 0; k < 8; k++) if (k < n) delta = max(delta, abs(v[k] - h[k]));
  float alpha = max(1.0 - 0.7 * uStability, min(1.0, delta * 4.0));
  for (int k = 0; k < 8; k++) if (k < n) v[k] = h[k] + (v[k] - h[k]) * alpha;
}

void writeHistory(float v[8]) {
  oHistA = vec4(v[0], v[1], v[2], v[3]);
  oHistB = vec4(v[4], v[5], v[6], v[7]);
}

vec4 glyphTexel(int g, int k) {
  return uGlyphData[2 * g + k];
}
`;

/** §5b: the stroke override of shape and ramp cells (edges.ts edgeStroke). */
const EDGE_CELL = `
uniform bool uEdges;
uniform sampler2D uDoG;
uniform float uTanSteep;
uniform float uTanFlat;
uniform vec4 uEdgeNorm;
uniform float uLowSplit;
uniform float uEdgeThreshold;
uniform float uEdgeBand;
uniform int uStrokes[5];

float dogAt(ivec2 p) {
  return texelFetch(uDoG, clamp(p, ivec2(0), uImage - 1), 0).r;
}

/** Stroke index of atlas glyph g, or -1. */
int strokeOf(int g) {
  for (int s = 0; s < 5; s++) if (uStrokes[s] == g) return s;
  return -1;
}

/** The glyph the cell shows: its fill glyph, or a stroke where the image has a strong, coherent edge. */
int withEdge(int fill) {
  if (!uEdges) return fill;
  float energy[4] = float[4](0.0, 0.0, 0.0, 0.0);
  float lowMoment = 0.0;
  for (int y = 0; y < SH; y++) {
    for (int x = 0; x < SW; x++) {
      ivec2 p = gBase + ivec2(x, y);
      float a = dogAt(p + ivec2(-1, -1));
      float b = dogAt(p + ivec2(0, -1));
      float c = dogAt(p + ivec2(1, -1));
      float d = dogAt(p + ivec2(-1, 0));
      float f = dogAt(p + ivec2(1, 0));
      float g = dogAt(p + ivec2(-1, 1));
      float h = dogAt(p + ivec2(0, 1));
      float i = dogAt(p + ivec2(1, 1));
      float gx = c + 2.0 * f + i - (a + 2.0 * d + g);
      float gy = g + 2.0 * h + i - (a + 2.0 * b + c);
      float m = sqrt(gx * gx + gy * gy);
      float ax = abs(gx);
      float ay = abs(gy);
      int bin;
      if (ay <= uTanSteep * ax) bin = 0;
      else if (ay >= uTanFlat * ax) bin = 3;
      else bin = gx * gy > 0.0 ? 1 : 2;
      energy[bin] += m;
      if (bin == 3) lowMoment += m * (float(y) + 0.5);
    }
  }
  int best = 0;
  for (int k = 1; k < 4; k++) if (energy[k] > energy[best]) best = k;
  float total = energy[0] + energy[1] + energy[2] + energy[3];
  if (!(energy[best] > 0.0) || energy[best] < ${glf(EDGE_COHERENCE)} * total) return fill;
  int stroke = best == 3 && lowMoment / energy[best] > uLowSplit ? 4 : best;
  int prevStroke = gPrevValid ? strokeOf(gPrevGlyph) : -1;
  float need = uEdgeThreshold - (stroke == prevStroke ? uEdgeBand : 0.0);
  return energy[best] / uEdgeNorm[best] >= need ? uStrokes[stroke] : fill;
}
`;

const SHAPE_MAIN = `
struct Query {
  float m;
  float r[6];
  float s;
};

Query prepareQuery(float q[6]) {
  Query Q;
  Q.m = (q[0] + q[1] + q[2] + q[3] + q[4] + q[5]) / 6.0;
  float n2 = 0.0;
  for (int k = 0; k < 6; k++) {
    Q.r[k] = q[k] - Q.m;
    n2 += Q.r[k] * Q.r[k];
  }
  Q.s = min(1.0, max(${glf(SHAPE_MIN)}, sqrt(n2) / ${glf(SHAPE_TAU)}));
  return Q;
}

float glyphDistance(Query Q, int g) {
  vec4 a = glyphTexel(g, 0);
  vec4 b = glyphTexel(g, 1);
  float t = Q.m - a.x;
  float e0 = Q.r[0] - a.y;
  float e1 = Q.r[1] - a.z;
  float e2 = Q.r[2] - a.w;
  float e3 = Q.r[3] - b.x;
  float e4 = Q.r[4] - b.y;
  float e5 = Q.r[5] - b.z;
  return 6.0 * t * t + Q.s * (e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3 + e4 * e4 + e5 * e5);
}

void main() {
  gCell = ivec2(gl_FragCoord.xy);
  gBase = gCell * ivec2(SW, SH);
  loadHistory();
  float tone;
  vec3 colour;
  cellMeans(tone, colour);

  float q[6];
  float e[10];
  internalCircles(q);
  externalCircles(e);
  if (uGlobal != 1.0) {
    float m = max(max(max(q[0], q[1]), max(q[2], q[3])), max(q[4], q[5]));
    if (m > 0.0) for (int k = 0; k < 6; k++) q[k] = pow(q[k] / m, uGlobal) * m;
  }
  if (uDirectional != 1.0) {
${DIRECTIONAL}
  }
  float n = cellNoise();
  float v[8] = float[8](0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (int k = 0; k < 6; k++) v[k] = toneDither(q[k], n);
  smoothFeatures(v, 6);

  float qa[6];
  for (int k = 0; k < 6; k++) qa[k] = v[k] * uAnchor;
  Query Q = prepareQuery(qa);
  int best = 0;
  float bestD = 3.0e38;
  for (int g = 0; g < uGlyphCount; g++) {
    float d = glyphDistance(Q, g);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  // Keep the previous glyph while it is nearly as good (an edge stroke outside the charset is not matchable).
  if (gPrevGlyph >= 0 && gPrevGlyph < uGlyphCount && gPrevGlyph != best && bestD >= glyphDistance(Q, gPrevGlyph) - uStability * 0.02) best = gPrevGlyph;
  best = withEdge(best);

  oCell = vec4(float(best), tone, packRgb(colour), 0.0);
  writeHistory(v);
}
`;

const RAMP_MAIN = `
void main() {
  gCell = ivec2(gl_FragCoord.xy);
  gBase = gCell * ivec2(SW, SH);
  loadHistory();
  float tone;
  vec3 colour;
  cellMeans(tone, colour);

  float v[8] = float[8](0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  v[0] = toneDither(tone, cellNoise());
  smoothFeatures(v, 1);
  float t = v[0] * uAnchor;
  int best = 0;
  float bestD = 3.0e38;
  // Candidates only (glyphTexel(g, 1).w = 1): see GlyphSet.rampGlyphs.
  for (int g = 0; g < uGlyphCount; g++) {
    if (glyphTexel(g, 1).w < 0.5) continue;
    float d = abs(t - glyphTexel(g, 0).x);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (gPrevGlyph >= 0 && gPrevGlyph < uGlyphCount && gPrevGlyph != best && glyphTexel(gPrevGlyph, 1).w > 0.5 && bestD >= abs(t - glyphTexel(gPrevGlyph, 0).x) - uStability * 0.02) best = gPrevGlyph;
  best = withEdge(best);

  oCell = vec4(float(best), tone, packRgb(colour), 0.0);
  writeHistory(v);
}
`;

const BRAILLE_MAIN = `
void main() {
  gCell = ivec2(gl_FragCoord.xy);
  gBase = gCell * ivec2(SW, SH);
  loadHistory();
  float tone;
  vec3 colour;
  cellMeans(tone, colour);

  float v[8];
  brailleDots(v);
  smoothFeatures(v, 8);
  // §8 hysteresis: a dot that was on stays on down to threshold − band, an off one needs threshold + band.
  int bits = 0;
  for (int i = 0; i < 8; i++) {
    float t = threshold(gCell.x * 2 + (i & 1), gCell.y * 4 + (i >> 1));
    int side = gPrevGlyph < 0 ? 0 : ((gPrevGlyph & BRAILLE[i]) != 0 ? -1 : 1);
    if (v[i] > t + hysteresis(t, side)) bits |= BRAILLE[i];
  }
  oCell = vec4(float(bits), tone, packRgb(colour), 0.0);
  writeHistory(v);
}
`;

const BLOCKS_MAIN = `
const float FIT_EPS = 1e-9;
const float TONE_EPS = 1e-6;

vec3 groupMean(vec3 quad[4], int mask, int want, out int n) {
  vec3 s = vec3(0.0);
  n = 0;
  for (int i = 0; i < 4; i++) {
    if (((mask >> i) & 1) != want) continue;
    n++;
    s += quad[i];
  }
  return n > 0 ? s / float(n) : vec3(0.0);
}

float groupError(vec3 quad[4], int mask, int want) {
  int n;
  vec3 m = groupMean(quad, mask, want, n);
  if (n == 0) return 0.0;
  float e = 0.0;
  for (int i = 0; i < 4; i++) {
    if (((mask >> i) & 1) != want) continue;
    vec3 d = quad[i] - m;
    e += d.r * d.r + d.g * d.g + d.b * d.b;
  }
  return e;
}

float partitionError(vec3 quad[4], int mask) {
  return groupError(quad, mask, 1) + groupError(quad, mask, 0);
}

void main() {
  gCell = ivec2(gl_FragCoord.xy);
  gBase = gCell * ivec2(SW, SH);
  loadHistory();
  float tone;
  vec3 colour;
  cellMeans(tone, colour);

  float v[8];
  quadrantTones(v);
  smoothFeatures(v, 4);
  int prev = gPrevGlyph;
  int bits = 0;
  vec3 fg = colour;
  vec3 bg = vec3(0.0);
  if (uBlocksColour) {
    // Two colours per cell (cpu.ts fitTwoColours): the partition of the quadrant colours with least
    // squared error; complementary partitions tie, so masks 0..7 suffice. The inkier side is 'on'.
    // Errors and tones within FIT_EPS / TONE_EPS count as ties (→ lowest mask, no flip): f32 sums
    // leave ~1e-7 noise between quadrants of a flat area, which must not pick a partition. §8 keeps
    // the previous partition within uFitBand and its orientation within uBand.
    vec3 quad[4];
    for (int i = 0; i < 4; i++) quad[i] = quadColour(i);
    int bestMask = 0;
    float bestErr = 3.0e38;
    for (int m = 0; m < 8; m++) {
      float err = partitionError(quad, m);
      if (err < bestErr - FIT_EPS) {
        bestErr = err;
        bestMask = m;
      }
    }
    int prevMask = prev < 0 ? -1 : (prev < 8 ? prev : 15 - prev);
    if (bestMask != 0 && prevMask >= 0 && prevMask != bestMask && partitionError(quad, prevMask) <= bestErr + uFitBand) bestMask = prevMask;
    float onT = 0.0;
    float offT = 0.0;
    int onN = 0;
    for (int i = 0; i < 4; i++) {
      if (((bestMask >> i) & 1) == 1) {
        onT += v[i];
        onN++;
      } else {
        offT += v[i];
      }
    }
    if (bestMask == 0) {
      float margin = prev == 15 ? -uBand : (prev == 0 ? uBand : 0.0);
      bits = offT / 4.0 > 0.5 + margin ? 15 : 0;
    } else {
      float margin = prev == bestMask ? uBand : (prev == 15 - bestMask ? -uBand : 0.0);
      bits = onT / float(onN) - offT / float(4 - onN) < -TONE_EPS - margin ? 15 - bestMask : bestMask;
    }
    int nf;
    int nb;
    fg = groupMean(quad, bits, 1, nf);
    bg = groupMean(quad, bits, 0, nb);
    if (nf == 0) fg = bg;
    if (nb == 0) bg = fg;
  } else {
    for (int i = 0; i < 4; i++) {
      float t = threshold(gCell.x * 2 + (i & 1), gCell.y * 2 + (i >> 1));
      int side = prev < 0 ? 0 : (((prev >> i) & 1) != 0 ? -1 : 1);
      if (v[i] > t + hysteresis(t, side)) bits |= 1 << i;
    }
  }
  oCell = vec4(float(bits), tone, packRgb(fg), packRgb(bg));
  writeHistory(v);
}
`;

const HALFTONE_MAIN = `
void main() {
  gCell = ivec2(gl_FragCoord.xy);
  gBase = gCell * ivec2(SW, SH);
  loadHistory();
  float tone;
  vec3 colour;
  cellMeans(tone, colour);

  float v[8] = float[8](tone, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  smoothFeatures(v, 1);
  int index = int(clamp(floor(v[0] * 3.0 + 0.5), 0.0, 3.0));
  oCell = vec4(float(index), v[0], packRgb(colour), 0.0);
  writeHistory(v);
}
`;

/**
 * Uniform-driven geometry: SW, SH and the tap tables come from uniforms and the `Taps` block, so
 * this one program per mode serves every font and line height the moment they change.
 */
const GENERIC_GEOMETRY = `
uniform int uSW;
uniform int uSH;
#define SW uSW
#define SH uSH
`;

const GENERIC_SAMPLING = `
// Tap tables of the current geometry (§2): per table (first tap, tap count); per tap (dx, dy, w).
layout(std140) uniform Taps {
  ivec4 uTapRange[${MAX_TAP_TABLES}];
  vec4 uTap[${MAX_TAPS}];
};

/** Weighted sum of the analysis image over one tap table, summed in table order like the CPU. */
float tapSum(int table) {
  ivec4 r = uTapRange[table];
  float s = 0.0;
  for (int i = r.x; i < r.x + r.y; i++) {
    vec4 t = uTap[i];
    s += t.z * texelFetch(uL, clamp(gBase + ivec2(t.xy), ivec2(0), uImage - 1), 0).r;
  }
  return s;
}

void internalCircles(out float q[6]) {
  for (int k = 0; k < 6; k++) q[k] = tapSum(${TAP_TABLES.internal} + k);
}

void externalCircles(out float e[10]) {
  for (int j = 0; j < 10; j++) e[j] = tapSum(${TAP_TABLES.external} + j);
}

void brailleDots(out float v[8]) {
  for (int i = 0; i < 8; i++) v[i] = tapSum(${TAP_TABLES.braille} + i);
}

void quadrantTones(out float v[8]) {
  for (int i = 0; i < 8; i++) v[i] = i < 4 ? tapSum(${TAP_TABLES.blocks} + i) : 0.0;
}
`;

/**
 * A weighted-sum function over tap tables, one output per table, with every tap a literal offset
 * and weight (f32, summed in table order like the CPU): no tap lookups and no runtime loop
 * bounds, so the compiler can issue all the fetches at once.
 */
function tapFunction(name: string, tables: readonly TapTable[], clampToImage: boolean): string {
  const lines = tables.map((t, k) => {
    const terms = Array.from(t.w, (w, i) => {
      const p = `gBase + ivec2(${t.dx[i]}, ${t.dy[i]})`;
      return `  s += ${glf(Math.fround(w))} * texelFetch(uL, ${clampToImage ? `clamp(${p}, ivec2(0), uImage - 1)` : p}, 0).r;`;
    });
    return `  s = 0.0;\n${terms.join('\n')}\n  out_[${k}] = s;`;
  });
  return `void ${name}(out float out_[${tables.length}]) {\n  float s;\n${lines.join('\n')}\n}\n`;
}

/** Same, padding an 8-wide feature vector (braille dots, block quadrants). */
function featureFunction(name: string, tables: readonly TapTable[]): string {
  const n = tables.length;
  return `${tapFunction(`${name}Raw`, tables, false)}void ${name}(out float v[8]) {
  float raw[${n}];
  ${name}Raw(raw);
  for (int i = 0; i < 8; i++) v[i] = i < ${n} ? raw[i] : 0.0;
}
`;
}

/**
 * Specialised geometry: SW, SH and every tap compiled in as constants. Measured on ANGLE / Metal at
 * 200 × 110 cells this runs pass 2 about twice as fast as the uniform-driven program (constant
 * loop bounds unroll; literal taps need no lookups), so the renderer compiles it in the background
 * for the current geometry and switches over once it is ready.
 */
function specialisedSampling(mode: RenderMode, sw: number, sh: number): string {
  const taps = buildTapTables(sw, sh);
  if (mode === 'shape') return tapFunction('internalCircles', taps.internal, false) + tapFunction('externalCircles', taps.external, true);
  if (mode === 'braille') return featureFunction('brailleDots', buildRectTaps(sw, sh, 2, 4));
  if (mode === 'blocks') return featureFunction('quadrantTones', buildRectTaps(sw, sh, 2, 2));
  return '';
}

const CELL_MAINS: Record<RenderMode, string> = {
  shape: EDGE_CELL + SHAPE_MAIN,
  ramp: EDGE_CELL + RAMP_MAIN,
  braille: BRAILLE_MAIN,
  blocks: BLOCKS_MAIN,
  halftone: HALFTONE_MAIN,
};

// ------------------------------------------------------------------------------------------------
// Pass 3: compose.

export type ComposeKind = 'text' | 'braille' | 'blocks' | 'halftone';

export function composeKindOf(mode: RenderMode): ComposeKind {
  return mode === 'shape' || mode === 'ramp' ? 'text' : mode;
}

const COMPOSE_COMMON = `${HEADER}precision highp sampler2DArray;

uniform sampler2D uCells;
uniform sampler2DArray uAtlas;
uniform sampler2D uSrc;
uniform ivec2 uGrid;
uniform vec2 uCellSize;
uniform vec2 uOrigin;
uniform float uZoom;
uniform vec2 uFragOffset;
uniform bool uFlipY;
uniform bool uOutsideClear;
uniform bool uTransparent;
uniform bool uPremultiply;
uniform int uColorMode;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uShadow;
uniform float uSplit;
uniform bool uExact;
uniform ivec2 uPad;
uniform ivec2 uReach;
uniform ivec2 uTile;
uniform vec2 uGrad;
uniform bool uBlocksColour;
uniform vec2 uBlockSplit;
uniform vec2 uHtDir;
uniform vec2 uHtAxis;
uniform int uHtShape;

out vec4 oColor;

const int BRAILLE[8] = int[8](${BRAILLE});
const float PI = 3.141592653589793;

vec3 unpackRgb(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  return vec3(r, g, v - r * 65536.0 - g * 256.0);
}

/** §7 glyph colour (0..1) of one cell, rounded to 8 bits exactly like the CPU raster. */
vec3 foreground(vec4 cell) {
  if (uColorMode == 1) {
    vec3 c = unpackRgb(cell.z);
    if (uBlocksColour) return c / 255.0;
    float k = 255.0 / max(max(c.r, c.g), max(c.b, 63.75));
    return min(vec3(255.0), floor(c * k + 0.5)) / 255.0;
  }
  if (uColorMode == 2) {
    float t = sqrt(clamp(cell.y, 0.0, 1.0));
    t = t * t * (3.0 - 2.0 * t);
    return floor(uShadow + (uInk - uShadow) * t + 0.5) / 255.0;
  }
  return uInk / 255.0;
}

vec4 paperColour() {
  return uTransparent ? vec4(0.0) : vec4(uPaper / 255.0, 1.0);
}

/** Premultiplied source-over of a straight colour with coverage a. */
vec4 over(vec4 acc, vec3 rgb, float a) {
  return vec4(rgb * a, a) + acc * (1.0 - a);
}

float overlap1(float a0, float a1, float b0, float b1) {
  return max(0.0, min(a1, b1) - max(a0, b0));
}

float overlapArea(vec2 lo, vec2 hi, vec2 a, vec2 b) {
  return overlap1(lo.x, hi.x, a.x, b.x) * overlap1(lo.y, hi.y, a.y, b.y);
}

int floorDiv(int a, int b) {
  return a >= 0 ? a / b : -((-a + b - 1) / b);
}

bool inGrid(ivec2 c) {
  return all(greaterThanEqual(c, ivec2(0))) && all(lessThan(c, uGrid));
}
`;

const TEXT_INK = `
/**
 * Glyphs from the atlas. Each tile carries uPad output px of padding, so ink that overflows its
 * cell (descenders at small line heights) is drawn by sampling the neighbouring cells too, in
 * the same row-major order the CPU raster draws them.
 */
vec4 ink(vec2 P, vec2 p, float h, vec4 acc) {
  ivec2 Pi = ivec2(floor(P - uOrigin));
  int s = int(uZoom);
  ivec2 cs = ivec2(uCellSize) * s;
  ivec2 c0 = uExact ? ivec2(floorDiv(Pi.x, cs.x), floorDiv(Pi.y, cs.y)) : ivec2(floor(p / uCellSize));
  vec2 padded = uCellSize + 2.0 * vec2(uPad);
  for (int dy = -uReach.y; dy <= uReach.y; dy++) {
    for (int dx = -uReach.x; dx <= uReach.x; dx++) {
      ivec2 c = c0 + ivec2(dx, dy);
      if (!inGrid(c)) continue;
      vec4 cell = texelFetch(uCells, c, 0);
      int g = int(cell.x);
      if (g == 0) continue;
      float cov;
      if (uExact) {
        ivec2 t = Pi - c * cs + uPad * s;
        if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, uTile))) continue;
        cov = texelFetch(uAtlas, ivec3(t, g), 0).r;
      } else {
        vec2 uv = (p - vec2(c) * uCellSize + vec2(uPad)) / padded;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) continue;
        cov = textureGrad(uAtlas, vec3(uv, float(g)), vec2(uGrad.x, 0.0), vec2(0.0, uGrad.y)).r;
      }
      if (cov > 0.0) acc = over(acc, foreground(cell), cov);
    }
  }
  return acc;
}
`;

const BRAILLE_INK = `
/** Eight anti-aliased discs per cell at the sub-cell centres (§6). */
vec4 ink(vec2 P, vec2 p, float h, vec4 acc) {
  ivec2 c = ivec2(floor(p / uCellSize));
  if (!inGrid(c)) return acc;
  vec4 cell = texelFetch(uCells, c, 0);
  int bits = int(cell.x);
  if (bits == 0) return acc;
  vec2 lp = p - vec2(c) * uCellSize;
  vec2 pitch = uCellSize / vec2(2.0, 4.0);
  ivec2 d = clamp(ivec2(floor(lp / pitch)), ivec2(0), ivec2(1, 3));
  if ((bits & BRAILLE[d.y * 2 + d.x]) == 0) return acc;
  float r = 0.36 * min(pitch.x, pitch.y);
  float cov = clamp((r - length(lp - (vec2(d) + 0.5) * pitch)) * uZoom + 0.5, 0.0, 1.0);
  return over(acc, foreground(cell), cov);
}
`;

const BLOCKS_INK = `
/**
 * Quadrant rectangles, box-filtered over the pixel footprint (which may straddle up to 3 cells
 * per axis at small zooms), so block edges stay seamless at fractional preview zoom and exact
 * at integer export scales. Returns the whole pixel, background included.
 */
vec4 ink(vec2 P, vec2 p, float h, vec4 acc) {
  vec2 lo = p - h;
  vec2 hi = p + h;
  float area = 4.0 * h * h;
  ivec2 c0 = ivec2(floor(lo / uCellSize));
  ivec2 c1 = ivec2(floor(hi / uCellSize));
  vec4 outside = uOutsideClear ? vec4(0.0) : paperColour();
  vec4 sum = vec4(0.0);
  float covered = 0.0;
  for (int iy = 0; iy < 3; iy++) {
    int cy = c0.y + iy;
    if (cy > c1.y) break;
    for (int ix = 0; ix < 3; ix++) {
      int cx = c0.x + ix;
      if (cx > c1.x) break;
      ivec2 c = ivec2(cx, cy);
      if (!inGrid(c)) continue;
      vec2 a = vec2(c) * uCellSize;
      vec2 b = a + uCellSize;
      float cellArea = overlapArea(lo, hi, a, b);
      if (cellArea <= 0.0) continue;
      covered += cellArea;
      vec4 cell = texelFetch(uCells, c, 0);
      int bits = int(cell.x);
      vec2 m = a + uBlockSplit;
      float on = 0.0;
      if ((bits & 1) != 0) on += overlapArea(lo, hi, a, m);
      if ((bits & 2) != 0) on += overlapArea(lo, hi, vec2(m.x, a.y), vec2(b.x, m.y));
      if ((bits & 4) != 0) on += overlapArea(lo, hi, vec2(a.x, m.y), vec2(m.x, b.y));
      if ((bits & 8) != 0) on += overlapArea(lo, hi, m, b);
      vec4 bg = uBlocksColour ? vec4(unpackRgb(cell.w) / 255.0, 1.0) : paperColour();
      sum += vec4(foreground(cell), 1.0) * on + bg * (cellArea - on);
    }
  }
  return (sum + outside * max(0.0, area - covered)) / area;
}
`;

const HALFTONE_INK = `
/** Signed distance (output px) to an equal-area dot of coverage c (§6 shapes). */
float dotDistance(vec2 d, float c, float pitch) {
  if (uHtShape == 0) return length(d) - pitch * sqrt(c / PI);
  vec2 v = vec2(-uHtAxis.y, uHtAxis.x);
  float hu = uHtShape == 3 ? pitch * 0.5 : pitch * sqrt(c) * 0.5;
  float hv = uHtShape == 3 ? pitch * c * 0.5 : hu;
  return max(abs(dot(d, uHtAxis)) - hu, abs(dot(d, v)) - hv);
}

/**
 * Dots on a lattice of pitch cellW rotated about the grid centre; each takes the tone and colour
 * of the cell under its centre (like the CPU raster and SVG export). The nearest lattice point
 * and its 8 neighbours can reach a pixel; they are composited in the CPU's drawing order.
 */
vec4 ink(vec2 P, vec2 p, float h, vec4 acc) {
  vec2 gridPx = vec2(uGrid) * uCellSize;
  float clipCov = overlapArea(p - h, p + h, vec2(0.0), gridPx) / (4.0 * h * h);
  if (clipCov <= 0.0) return acc;
  float pitch = uCellSize.x;
  vec2 centre = gridPx * 0.5;
  vec2 u = uHtDir;
  vec2 v = vec2(-u.y, u.x);
  vec2 d = p - centre;
  ivec2 n0 = ivec2(floor(vec2(dot(d, u), dot(d, v)) / pitch + 0.5));
  for (int j = n0.y - 1; j <= n0.y + 1; j++) {
    for (int i = n0.x - 1; i <= n0.x + 1; i++) {
      vec2 x = centre + (float(i) * u + float(j) * v) * pitch;
      if (x.x < -pitch || x.y < -pitch || x.x > gridPx.x + pitch || x.y > gridPx.y + pitch) continue;
      ivec2 c = clamp(ivec2(floor(x / uCellSize)), ivec2(0), uGrid - 1);
      vec4 cell = texelFetch(uCells, c, 0);
      if (cell.y <= 0.0) continue;
      float a = clamp(0.5 - dotDistance(p - x, cell.y, pitch) * uZoom, 0.0, 1.0) * clipCov;
      if (a > 0.0) acc = over(acc, foreground(cell), a);
    }
  }
  return acc;
}
`;

/** The source, as the left side of a compare split shows it (premultiplied when uTransparent). */
const SOURCE_SAMPLE = `
vec4 sourceSample(vec2 p, vec2 gridPx) {
  vec2 g = vec2(1.0 / uZoom) / gridPx;
  vec4 s = textureGrad(uSrc, clamp(p / gridPx, 0.0, 1.0), vec2(g.x, 0.0), vec2(0.0, g.y));
  return uTransparent ? vec4(s.rgb * s.a, s.a) : vec4(mix(uPaper / 255.0, s.rgb, s.a), 1.0);
}
`;

const COMPOSE_MAIN = `${SOURCE_SAMPLE}
void main() {
  vec2 P = vec2(gl_FragCoord.x + uFragOffset.x, uFlipY ? uFragOffset.y - gl_FragCoord.y : gl_FragCoord.y + uFragOffset.y);
  vec2 p = (P - uOrigin) / uZoom;
  float h = 0.5 / uZoom;
  vec2 gridPx = vec2(uGrid) * uCellSize;
  float gridCov = overlapArea(p - h, p + h, vec2(0.0), gridPx) / (4.0 * h * h);
  vec4 base = uOutsideClear ? paperColour() * gridCov : paperColour();
  vec4 acc = ink(P, p, h, base);
  if (P.x < uSplit && gridCov > 0.0) {
    vec4 outside = uOutsideClear ? vec4(0.0) : paperColour();
    acc = mix(outside, sourceSample(p, gridPx), gridCov);
  }
  oColor = uPremultiply ? acc : (acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0));
}
`;

const COMPOSE_INK: Record<ComposeKind, string> = {
  text: TEXT_INK,
  braille: BRAILLE_INK,
  blocks: BLOCKS_INK,
  halftone: HALFTONE_INK,
};

/**
 * Minified preview (zoom < 0.75): the grid composed at scale 1 (exactly the 1× export), box-filtered
 * over each canvas pixel's footprint, so glyphs, braille dots and halftone screens are area-averaged
 * instead of point-sampled (no beat patterns, no trilinear blur). Mip levels keep the footprint
 * within PRESENT_MAX_FOOT texels per axis. Writes premultiplied colour for the preview canvas.
 */
const PRESENT_FS = `${HEADER}
uniform sampler2D uRaster;
uniform int uMaxLevel;
uniform sampler2D uSrc;
uniform ivec2 uGrid;
uniform vec2 uCellSize;
uniform vec2 uOrigin;
uniform float uZoom;
uniform vec2 uFragOffset;
uniform bool uFlipY;
uniform bool uTransparent;
uniform vec3 uPaper;
uniform float uSplit;

out vec4 oColor;

const int MAX_FOOT = ${PRESENT_MAX_FOOT};

float overlap1(float a0, float a1, float b0, float b1) {
  return max(0.0, min(a1, b1) - max(a0, b0));
}
${SOURCE_SAMPLE}
void main() {
  vec2 P = vec2(gl_FragCoord.x + uFragOffset.x, uFlipY ? uFragOffset.y - gl_FragCoord.y : gl_FragCoord.y + uFragOffset.y);
  vec2 p = (P - uOrigin) / uZoom;
  float h = 0.5 / uZoom;
  vec2 gridPx = vec2(uGrid) * uCellSize;
  vec2 lo = p - h;
  vec2 hi = p + h;
  float gridCov = overlap1(lo.x, hi.x, 0.0, gridPx.x) * overlap1(lo.y, hi.y, 0.0, gridPx.y) / (4.0 * h * h);
  if (gridCov <= 0.0) {
    oColor = vec4(0.0);
    return;
  }
  if (P.x < uSplit) {
    oColor = sourceSample(p, gridPx) * gridCov;
    return;
  }
  int level = 0;
  float texel = 1.0;
  while (level < uMaxLevel && 2.0 * h > float(MAX_FOOT) * texel) {
    level++;
    texel *= 2.0;
  }
  vec2 a = lo / texel;
  vec2 b = hi / texel;
  ivec2 size = textureSize(uRaster, level);
  ivec2 t0 = ivec2(floor(a));
  vec4 acc = vec4(0.0);
  for (int y = 0; y <= MAX_FOOT + 1; y++) {
    int ty = t0.y + y;
    if (float(ty) >= b.y) break;
    if (ty < 0 || ty >= size.y) continue;
    float wy = overlap1(a.y, b.y, float(ty), float(ty) + 1.0);
    for (int x = 0; x <= MAX_FOOT + 1; x++) {
      int tx = t0.x + x;
      if (float(tx) >= b.x) break;
      if (tx < 0 || tx >= size.x) continue;
      acc += overlap1(a.x, b.x, float(tx), float(tx) + 1.0) * wy * texelFetch(uRaster, ivec2(tx, ty), level);
    }
  }
  oColor = acc / ((b.x - a.x) * (b.y - a.y));
}
`;

// ------------------------------------------------------------------------------------------------
// Program registry.

/**
 * `cell:<mode>` is the uniform-driven pass 2; `cell:<mode>:<SW>x<SH>` the one specialised for that
 * sub-cell size (specialisedCellKey).
 */
export type ProgramKey =
  | 'lightness'
  | 'quadrants'
  | 'edge-blur'
  | 'edge-dog'
  | `cell:${RenderMode}`
  | `cell:${RenderMode}:${number}x${number}`
  | `compose:${ComposeKind}`
  | 'present'
  | 'copy-source';

export function specialisedCellKey(mode: RenderMode, sw: number, sh: number): ProgramKey {
  return `cell:${mode}:${sw}x${sh}`;
}

const MODES: readonly RenderMode[] = ['shape', 'ramp', 'braille', 'blocks', 'halftone'];
const KINDS: readonly ComposeKind[] = ['text', 'braille', 'blocks', 'halftone'];

/** Every program the preview and exports use (the diagnostics-only copy-source is left out). */
export const PROGRAM_KEYS: readonly ProgramKey[] = [
  'lightness',
  'quadrants',
  ...MODES.map((m) => `cell:${m}` as const),
  ...KINDS.map((k) => `compose:${k}` as const),
  'present',
  'edge-blur',
  'edge-dog',
];

export function fragmentSource(key: ProgramKey): string {
  switch (key) {
    case 'lightness':
      return LIGHTNESS_FS;
    case 'quadrants':
      return QUADRANT_FS;
    case 'edge-blur':
      return EDGE_BLUR_FS;
    case 'edge-dog':
      return EDGE_DOG_FS;
    case 'present':
      return PRESENT_FS;
    case 'copy-source':
      // Diagnostics: the source texture as the passes see it.
      return COPY_SOURCE_FS;
  }
  if (key.startsWith('cell:')) {
    const [, mode, size] = key.split(':') as [string, RenderMode, string | undefined];
    if (!size) return HEADER + GENERIC_GEOMETRY + CELL_COMMON + GENERIC_SAMPLING + CELL_MAINS[mode];
    const [sw, sh] = size.split('x').map(Number);
    return `${HEADER}#define SW ${sw}\n#define SH ${sh}\n` + CELL_COMMON + specialisedSampling(mode, sw, sh) + CELL_MAINS[mode];
  }
  return COMPOSE_COMMON + COMPOSE_INK[key.slice(8) as ComposeKind] + COMPOSE_MAIN;
}
