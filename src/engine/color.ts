/**
 * Colour helpers shared by tone mapping and the CPU raster.
 *
 * Public API
 *   parseHexColor('#rrggbb' | '#rgb') → [r, g, b] in 0..255
 *   luma(r, g, b)                     Rec. 709 weights on sRGB-encoded 0..1 values (§3, no linearisation)
 *   hexLuma(hex)                      luma of a CSS hex colour
 */

export type Rgb = [number, number, number];

export function parseHexColor(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid colour ${JSON.stringify(hex)} (expected #rrggbb)`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hexLuma(hex: string): number {
  const [r, g, b] = parseHexColor(hex);
  return luma(r / 255, g / 255, b / 255);
}
