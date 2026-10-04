/**
 * Glyph atlases for the compose pass: one R8 TEXTURE_2D_ARRAY layer per glyph (layer = glyph
 * index, so the space is layer 0 and stays empty), rasterised with the canonical drawGlyph at an
 * exact integer scale and mipmapped. A tile is the cell plus `pad` output px on every side, so
 * ink that overflows its cell (descenders at line height 1.0, tall brackets) is kept; the compose
 * shader then also samples the neighbouring cells.
 *
 * Public API
 *   InkPadding                                   { x, y } in output (scale-1) px, integers
 *   measureInkPadding(chars, geometry, factory)  → InkPadding: how far any glyph's ink leaves its cell
 *   GlyphAtlas                                   { scale, tileW, tileH, texture }
 *   buildGlyphAtlas(gl, chars, geometry, pad, scale, factory) → GlyphAtlas
 */
import type { CellGeometry } from '../types';
import { drawGlyph, type CanvasFactory } from '../atlas';
import type { GL } from './gl';

export interface InkPadding {
  x: number;
  y: number;
}

/** Ink fainter than this (of 255) is invisible; ignoring it avoids sampling neighbours for nothing. */
const INK_ALPHA_MIN = 3;
const MEASURE_SCALES = [1, 4];

/**
 * Draws every glyph into the middle cell of a 3 × 3-cell canvas at scales 1 and 4 (hinting makes
 * small sizes heavier) and returns the largest overflow beyond the cell, rounded up to whole
 * output px and capped at one cell.
 */
export function measureInkPadding(chars: readonly string[], geometry: CellGeometry, factory: CanvasFactory): InkPadding {
  let ox = 0;
  let oy = 0;
  for (const s of MEASURE_SCALES) {
    const cw = geometry.cellW * s;
    const ch = geometry.cellH * s;
    const w = cw * 3;
    const h = ch * 3;
    const { ctx } = factory(w, h);
    for (const c of chars) {
      if (c === ' ') continue;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      drawGlyph(ctx, c, cw, ch + geometry.baseline * s, geometry.fontSize * s, geometry.fontFamily);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] <= INK_ALPHA_MIN) continue;
          ox = Math.max(ox, (cw - x) / s, (x + 1 - 2 * cw) / s);
          oy = Math.max(oy, (ch - y) / s, (y + 1 - 2 * ch) / s);
        }
      }
    }
  }
  return { x: Math.min(geometry.cellW, Math.ceil(ox)), y: Math.min(geometry.cellH, Math.ceil(oy)) };
}

export interface GlyphAtlas {
  scale: number;
  /** Tile size in texels: (cellW + 2·pad.x)·scale × (cellH + 2·pad.y)·scale. */
  tileW: number;
  tileH: number;
  texture: WebGLTexture;
}

export function buildGlyphAtlas(
  gl: GL,
  chars: readonly string[],
  geometry: CellGeometry,
  pad: InkPadding,
  scale: number,
  factory: CanvasFactory,
): GlyphAtlas {
  const tileW = (geometry.cellW + 2 * pad.x) * scale;
  const tileH = (geometry.cellH + 2 * pad.y) * scale;
  const levels = Math.floor(Math.log2(Math.max(tileW, tileH))) + 1;
  const texture = gl.createTexture();
  if (!texture) throw new Error('Could not create the glyph atlas texture');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.R8, tileW, tileH, chars.length);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const { ctx } = factory(tileW, tileH);
  const coverage = new Uint8Array(tileW * tileH);
  const penX = pad.x * scale;
  const baseline = (pad.y + geometry.baseline) * scale;
  const fontSize = geometry.fontSize * scale;
  for (let g = 0; g < chars.length; g++) {
    if (chars[g] === ' ') continue;
    ctx.clearRect(0, 0, tileW, tileH);
    ctx.fillStyle = '#fff';
    drawGlyph(ctx, chars[g], penX, baseline, fontSize, geometry.fontFamily);
    const data = ctx.getImageData(0, 0, tileW, tileH).data;
    for (let i = 0; i < coverage.length; i++) coverage[i] = data[i * 4 + 3];
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, g, tileW, tileH, 1, gl.RED, gl.UNSIGNED_BYTE, coverage);
  }
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return { scale, tileW, tileH, texture };
}
