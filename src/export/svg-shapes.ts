import { BRAILLE_BITS, QUADRANT_CHARS } from '../engine/charsets';
import type { GridSnapshot } from '../engine/types';
import { toHex } from './color';
import { num } from './svg-number';

/**
 * Procedural modes (docs/ALGORITHM.md §6) as SVG primitives, with the same placement as the
 * engine's CPU raster (src/engine/rasterCpu.ts): braille dots → <circle>, block quadrants → <rect>
 * (horizontal runs merged), halftone → dots on the rotated lattice. Shapes are grouped by fill
 * colour so editors see one layer per colour.
 */

class ColorGroups {
  private readonly groups = new Map<number, string[]>();

  add(color: number, element: string): void {
    const list = this.groups.get(color);
    if (list) list.push(element);
    else this.groups.set(color, [element]);
  }

  toSvg(wrap: (fill: string, body: string) => string): string {
    let out = '';
    for (const [color, elements] of this.groups) out += wrap(toHex(color), elements.join(''));
    return out;
  }
}

const groupWrap = (fill: string, body: string) => `<g fill="${fill}">${body}</g>`;
const pathWrap = (fill: string, body: string) => `<path fill="${fill}" d="${body}"/>`;

export function brailleSvg(snapshot: GridSnapshot, fg: Uint32Array, margin: number): string {
  const { cellW, cellH } = snapshot.geometry;
  const radius = num(0.36 * Math.min(cellW / 2, cellH / 4));
  const groups = new ColorGroups();
  for (let r = 0; r < snapshot.rows; r++) {
    for (let c = 0; c < snapshot.cols; c++) {
      const i = r * snapshot.cols + c;
      const bits = (snapshot.chars[i]?.codePointAt(0) ?? 0x2800) - 0x2800;
      if (bits <= 0 || bits > 0xff) continue;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (!(bits & BRAILLE_BITS[dy][dx])) continue;
          const cx = margin + c * cellW + ((dx + 0.5) * cellW) / 2;
          const cy = margin + r * cellH + ((dy + 0.5) * cellH) / 4;
          groups.add(fg[i], `<circle cx="${num(cx)}" cy="${num(cy)}" r="${radius}"/>`);
        }
      }
    }
  }
  return groups.toSvg(groupWrap);
}

interface Run {
  q0: number;
  q1: number;
  color: number;
}

/** Runs of equal colour along one half-row of quadrants; null colours are left to the paper. */
function quadrantRuns(colors: (number | null)[]): Run[] {
  const runs: Run[] = [];
  for (let q = 0; q < colors.length; q++) {
    const color = colors[q];
    if (color === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.q1 === q && last.color === color) last.q1 = q + 1;
    else runs.push({ q0: q, q1: q + 1, color });
  }
  return runs;
}

export function blocksSvg(snapshot: GridSnapshot, fg: Uint32Array, bg: Uint32Array | null, margin: number): string {
  const { cellW, cellH } = snapshot.geometry;
  // Integer split inside the cell, as the raster draws it, so quadrants tile without seams.
  const xm = Math.round(cellW / 2);
  const ym = Math.round(cellH / 2);
  const qx = (q: number) => margin + (q >> 1) * cellW + (q & 1 ? xm : 0);
  const groups = new ColorGroups();
  const rect = (run: Run, y: number, h: number) =>
    `<rect x="${num(qx(run.q0))}" y="${num(y)}" width="${num(qx(run.q1) - qx(run.q0))}" height="${num(h)}"/>`;

  for (let r = 0; r < snapshot.rows; r++) {
    const top: (number | null)[] = [];
    const bottom: (number | null)[] = [];
    for (let c = 0; c < snapshot.cols; c++) {
      const i = r * snapshot.cols + c;
      const bits = Math.max(0, QUADRANT_CHARS.indexOf(snapshot.chars[i] ?? ' '));
      const off = bg ? bg[i] : null;
      top.push(bits & 1 ? fg[i] : off, bits & 2 ? fg[i] : off);
      bottom.push(bits & 4 ? fg[i] : off, bits & 8 ? fg[i] : off);
    }
    const y = margin + r * cellH;
    // A run present identically in both halves becomes one full-height rect.
    const bottomRuns = new Map(quadrantRuns(bottom).map((run) => [`${run.q0},${run.q1},${run.color}`, run]));
    for (const run of quadrantRuns(top)) {
      const key = `${run.q0},${run.q1},${run.color}`;
      const full = bottomRuns.delete(key);
      groups.add(run.color, rect(run, y, full ? cellH : ym));
    }
    for (const run of bottomRuns.values()) groups.add(run.color, rect(run, y + ym, cellH - ym));
  }
  return groups.toSvg(groupWrap);
}

/**
 * Halftone dots on a lattice of pitch cellW rotated by halftoneAngle about the grid centre. Each
 * dot takes the coverage and colour of the cell under its centre; every shape has area
 * pitch²·coverage (round: r = pitch·√(c/π)).
 */
export function halftoneSvg(snapshot: GridSnapshot, fg: Uint32Array, margin: number): string {
  const { cols, rows, params, tone } = snapshot;
  const { cellW, cellH } = snapshot.geometry;
  const pitch = cellW;
  const gw = cols * cellW;
  const gh = rows * cellH;
  const theta = (params.halftoneAngle * Math.PI) / 180;
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const shape = params.halftoneShape;
  const reach = Math.ceil(Math.hypot(gw, gh) / 2 / pitch) + 1;

  const circles = new ColorGroups();
  const polygons = new ColorGroups();
  for (let j = -reach; j <= reach; j++) {
    for (let i = -reach; i <= reach; i++) {
      const x = gw / 2 + (i * ux - j * uy) * pitch;
      const y = gh / 2 + (i * uy + j * ux) * pitch;
      if (x < -pitch || y < -pitch || x > gw + pitch || y > gh + pitch) continue;
      const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cellW)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(y / cellH)));
      const cell = row * cols + col;
      const c = Math.min(1, tone[cell]);
      if (!(c > 0)) continue;
      const cx = margin + x;
      const cy = margin + y;
      if (shape === 'round') {
        circles.add(fg[cell], `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(pitch * Math.sqrt(c / Math.PI))}"/>`);
        continue;
      }
      // Rectangle with half-extents (hu, hv) along the lattice axes (diamond: turned 45°).
      const rot = shape === 'diamond' ? theta + Math.PI / 4 : theta;
      const hu = shape === 'line' ? pitch / 2 : (pitch * Math.sqrt(c)) / 2;
      const hv = shape === 'line' ? (pitch * c) / 2 : hu;
      const ax = Math.cos(rot);
      const ay = Math.sin(rot);
      const corners = [
        [hu, hv],
        [-hu, hv],
        [-hu, -hv],
        [hu, -hv],
      ].map(([u, v]) => `${num(cx + ax * u - ay * v)} ${num(cy + ay * u + ax * v)}`);
      polygons.add(fg[cell], `M${corners.join('L')}Z`);
    }
  }
  return circles.toSvg(groupWrap) + polygons.toSvg(pathWrap);
}
