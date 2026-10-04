import { parseHexColor, type Rgb } from '../engine/color';
import { cellForeground } from '../engine/rasterCpu';
import type { GridSnapshot } from '../engine/types';

/** Colours are packed as 0xRRGGBB integers so runs can be compared and grouped cheaply. */
export type PackedRgb = number;

export function pack(r: number, g: number, b: number): PackedRgb {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export function unpack(rgb: PackedRgb): [number, number, number] {
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
}

export function parseHex(hex: string): PackedRgb {
  const [r, g, b] = parseHexColor(hex);
  return pack(r, g, b);
}

export function toHex(rgb: PackedRgb): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

export function mix(a: PackedRgb, b: PackedRgb, t: number): PackedRgb {
  const [ar, ag, ab] = unpack(a);
  const [br, bg, bb] = unpack(b);
  return pack(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Foreground colour of every cell, from the engine's own §7 rule (cellForeground) so vector and
 * text exports carry exactly the colours the raster draws.
 */
export function cellInkColors(snapshot: GridSnapshot): Uint32Array {
  const n = snapshot.cols * snapshot.rows;
  const out = new Uint32Array(n);
  const rgb: Rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    cellForeground(snapshot, i, rgb);
    out[i] = pack(rgb[0], rgb[1], rgb[2]);
  }
  return out;
}

/** Per-cell background (blocks' two-colour mode); null means every cell sits on the paper. */
export function cellBackgroundColors(snapshot: GridSnapshot): Uint32Array | null {
  const bg = snapshot.backgrounds;
  if (!bg) return null;
  const n = snapshot.cols * snapshot.rows;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = pack(bg[i * 3], bg[i * 3 + 1], bg[i * 3 + 2]);
  return out;
}
