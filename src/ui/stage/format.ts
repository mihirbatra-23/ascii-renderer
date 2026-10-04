/**
 * Number formatting shared by the top bar, stage caption and status bar (copy rules, spec §11):
 * units always shown, tabular figures, '×' between dimensions.
 */

export const dims = (w: number, h: number): string => `${w} × ${h}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Render time; the clock's resolution is 0.1 ms, so faster frames read '<0.1'. */
export function formatMs(ms: number): string {
  return ms < 0.1 ? '<0.1' : ms.toFixed(1);
}

/** '24 fps', '12.5 fps' */
export function formatFps(fps: number): string {
  return `${Number.isInteger(Math.round(fps * 10) / 10) ? Math.round(fps) : fps.toFixed(1)} fps`;
}

/** Simple ratios read as 'a:b' (16:9); awkward ones as a decimal ('1.50:1'). */
export function formatRatio(w: number, h: number): string {
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  return a <= 64 && b <= 64 ? `${a}:${b}` : `${(w / h).toFixed(2)}:1`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Signed percentage with two decimals: '+0.67%', '−0.40%'. */
export function formatDelta(d: number): string {
  const pct = d * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
}

/** Scale as typed on the controls: '2×', '1.37×'. */
export function formatScale(s: number): string {
  return `${Number.isInteger(s) ? s : s.toFixed(2)}×`;
}

/**
 * The aspect check from integers (spec §7): exact when outW·H = outH·W, otherwise the relative
 * error that rounding the row count introduced.
 */
export function aspectDelta(outW: number, outH: number, srcW: number, srcH: number): number {
  if (outW * srcH === outH * srcW) return 0;
  return outW / outH / (srcW / srcH) - 1;
}
