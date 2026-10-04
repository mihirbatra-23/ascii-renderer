/**
 * Color conversions for the swatch popover: `#rrggbb` ↔ HSV. The picker keeps its own HSV while
 * open, so hue survives dragging through grey (saturation 0) or black (value 0), where the hex
 * value alone would lose it.
 */

export interface Hsv {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

/** `#rgb` / `#rrggbb` (the '#' optional, any case) → `#rrggbb`, or null when it is not a color. */
export function normalizeHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${digits.toLowerCase()}`;
}

export function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  const byte = (c: number) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(f(5))}${byte(f(3))}${byte(f(1))}`;
}
