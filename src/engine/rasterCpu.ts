/**
 * CPU compose: draws a GridSnapshot at an exact raster size with Canvas2D. Used when WebGL2 is
 * unavailable and by Node tests / contact sheets. Glyphs go through drawGlyph (the canonical
 * baseline placement); braille, blocks and halftone are drawn procedurally (docs/ALGORITHM.md §6),
 * colours follow §7.
 *
 * Public API
 *   renderRasterCpu(snapshot, options, factory) → { canvas, ctx, width, height }
 *       size is exactly (cols·cellW + 2·margin)·scale × (rows·cellH + 2·margin)·scale
 *   cellForeground(snapshot, cell, out)         §7 glyph colour of one cell (RGB 0..255)
 *   duotoneWeight(tone)                         §7 duotone mix weight: smoothstep(√tone)
 */
import type { GridSnapshot, RasterOptions } from './types';
import { drawGlyph, type CanvasFactory, type GlyphContext } from './atlas';
import { parseHexColor, type Rgb } from './color';
import { rasterSize } from './geometry';
import { BRAILLE_BITS, QUADRANT_CHARS } from './charsets';

/**
 * §7 duotone weight of a cell's tone: smoothstep(√L̄). The glyph's coverage already shows a dark
 * cell as sparse ink; mixing its colour toward the shadow by L̄ itself darkened it a second time
 * (low-key images at ~40 % of Mono's displayed light). The square root lifts that weight while the
 * darkest cells keep the shadow colour.
 */
export function duotoneWeight(tone: number): number {
  const t = Math.sqrt(tone < 0 ? 0 : tone > 1 ? 1 : tone);
  return t * t * (3 - 2 * t);
}

export function cellForeground(snapshot: GridSnapshot, cell: number, out: Rgb): Rgb {
  const { params, colors, tone } = snapshot;
  const o = cell * 3;
  if (params.colorMode === 'source') {
    if (params.mode === 'blocks') {
      out[0] = colors[o];
      out[1] = colors[o + 1];
      out[2] = colors[o + 2];
    } else {
      // Brighten so the largest channel is 1: thin glyph strokes would otherwise read too dark.
      const k = 255 / Math.max(colors[o], colors[o + 1], colors[o + 2], 0.25 * 255);
      out[0] = Math.min(255, Math.round(colors[o] * k));
      out[1] = Math.min(255, Math.round(colors[o + 1] * k));
      out[2] = Math.min(255, Math.round(colors[o + 2] * k));
    }
  } else if (params.colorMode === 'duotone') {
    const ink = parseHexColor(params.ink);
    const shadow = parseHexColor(params.shadowInk);
    const t = duotoneWeight(tone[cell]);
    for (let c = 0; c < 3; c++) out[c] = Math.round(shadow[c] + (ink[c] - shadow[c]) * t);
  } else {
    const ink = parseHexColor(params.ink);
    out[0] = ink[0];
    out[1] = ink[1];
    out[2] = ink[2];
  }
  return out;
}

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Equal-area halftone dot (round / square / diamond / line) of coverage c at (x, y). */
function drawDot(ctx: GlyphContext, shape: GridSnapshot['params']['halftoneShape'], x: number, y: number, c: number, pitch: number, angle: number): void {
  if (c <= 0) return;
  ctx.beginPath();
  if (shape === 'round') {
    ctx.arc(x, y, pitch * Math.sqrt(c / Math.PI), 0, Math.PI * 2);
  } else {
    // Rectangle with half-extents (hu, hv) along the screen axes rotated by `rot`.
    const rot = shape === 'diamond' ? angle + Math.PI / 4 : angle;
    const hu = shape === 'line' ? pitch / 2 : (pitch * Math.sqrt(c)) / 2;
    const hv = shape === 'line' ? (pitch * c) / 2 : hu;
    const ux = Math.cos(rot);
    const uy = Math.sin(rot);
    ctx.moveTo(x + ux * hu - uy * hv, y + uy * hu + ux * hv);
    ctx.lineTo(x - ux * hu - uy * hv, y - uy * hu + ux * hv);
    ctx.lineTo(x - ux * hu + uy * hv, y - uy * hu - ux * hv);
    ctx.lineTo(x + ux * hu + uy * hv, y + uy * hu - ux * hv);
    ctx.closePath();
  }
  ctx.fill();
}

export function renderRasterCpu(
  snapshot: GridSnapshot,
  options: RasterOptions,
  factory: CanvasFactory,
): { canvas: unknown; ctx: GlyphContext; width: number; height: number } {
  const { cols, rows, geometry, params, chars } = snapshot;
  const s = options.scale;
  const margin = options.margin ?? 0;
  const { width, height } = rasterSize(snapshot, geometry, { scale: s, margin });
  const { canvas, ctx } = factory(width, height);
  ctx.clearRect(0, 0, width, height);
  if (!options.transparentBackground) {
    ctx.fillStyle = params.paper;
    ctx.fillRect(0, 0, width, height);
  }
  const cw = geometry.cellW * s;
  const ch = geometry.cellH * s;
  const ox = margin * s;
  const oy = margin * s;
  const fg: Rgb = [0, 0, 0];

  if (params.mode === 'halftone') {
    const pitch = cw;
    const angle = (params.halftoneAngle * Math.PI) / 180;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const gw = cols * cw;
    const gh = rows * ch;
    const cx = gw / 2;
    const cy = gh / 2;
    const reachCells = Math.ceil(Math.hypot(gw, gh) / 2 / pitch) + 1;
    // Dots near the edge are cut by the grid boundary, never spill into the margin.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, gw, gh);
    ctx.clip();
    for (let j = -reachCells; j <= reachCells; j++) {
      for (let i = -reachCells; i <= reachCells; i++) {
        const x = cx + (i * ux - j * uy) * pitch;
        const y = cy + (i * uy + j * ux) * pitch;
        if (x < -pitch || y < -pitch || x > gw + pitch || y > gh + pitch) continue;
        const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cw)));
        const row = Math.min(rows - 1, Math.max(0, Math.floor(y / ch)));
        const cell = row * cols + col;
        ctx.fillStyle = css(cellForeground(snapshot, cell, fg));
        drawDot(ctx, params.halftoneShape, ox + x, oy + y, snapshot.tone[cell], pitch, angle);
      }
    }
    ctx.restore();
    return { canvas, ctx, width, height };
  }

  const fontSize = geometry.fontSize * s;
  const baseline = geometry.baseline * s;
  const bg: Rgb = [0, 0, 0];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const x = ox + col * cw;
      const y = oy + row * ch;
      if (snapshot.backgrounds) {
        const o = cell * 3;
        bg[0] = snapshot.backgrounds[o];
        bg[1] = snapshot.backgrounds[o + 1];
        bg[2] = snapshot.backgrounds[o + 2];
        ctx.fillStyle = css(bg);
        ctx.fillRect(x, y, cw, ch);
      }
      const text = chars[cell];
      if (text === ' ') continue;
      ctx.fillStyle = css(cellForeground(snapshot, cell, fg));
      if (params.mode === 'braille') {
        const bits = text.charCodeAt(0) - 0x2800;
        const r = 0.36 * Math.min(cw / 2, ch / 4);
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (!(bits & BRAILLE_BITS[dy][dx])) continue;
            ctx.beginPath();
            ctx.arc(x + (dx + 0.5) * (cw / 2), y + (dy + 0.5) * (ch / 4), r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else if (params.mode === 'blocks') {
        const bits = QUADRANT_CHARS.indexOf(text);
        // Integer quadrant edges so neighbouring blocks tile without seams.
        const xm = Math.round(cw / 2);
        const ym = Math.round(ch / 2);
        if (bits & 1) ctx.fillRect(x, y, xm, ym);
        if (bits & 2) ctx.fillRect(x + xm, y, cw - xm, ym);
        if (bits & 4) ctx.fillRect(x, y + ym, xm, ch - ym);
        if (bits & 8) ctx.fillRect(x + xm, y + ym, cw - xm, ch - ym);
      } else {
        drawGlyph(ctx, text, x, y + baseline, fontSize, geometry.fontFamily);
      }
    }
  }
  return { canvas, ctx, width, height };
}
