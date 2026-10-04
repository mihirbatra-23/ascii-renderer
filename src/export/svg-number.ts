/**
 * Compact SVG numbers with at most two decimals. Coordinates are handled as integer hundredths of
 * a pixel so relative path segments can be summed without drift.
 */
export function formatHundredths(h: number): string {
  if (h === 0) return '0';
  const neg = h < 0;
  const a = neg ? -h : h;
  const whole = Math.floor(a / 100);
  const frac = a % 100;
  let s = whole === 0 ? '' : String(whole);
  if (frac !== 0) s += frac % 10 === 0 ? `.${frac / 10}` : `.${frac < 10 ? '0' : ''}${frac}`;
  return neg ? `-${s}` : s;
}

export function toHundredths(v: number): number {
  return Math.round(v * 100);
}

/** `v` rounded to two decimals, without trailing zeros or a leading zero (0.5 → '.5'). */
export function num(v: number): string {
  return formatHundredths(toHundredths(v));
}

/** Joins numbers the way SVG path data allows: a minus sign doubles as a separator. */
export function joinNumbers(parts: readonly string[]): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out += i === 0 || p.startsWith('-') ? p : ` ${p}`;
  }
  return out;
}
