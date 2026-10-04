/** Small helpers shared by the kit components. */
import { useSyncExternalStore } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Round to the step grid anchored at `min`, without float noise (0.1 + 0.2 style). */
export function snap(v: number, min: number, step: number): number {
  const decimals = Math.max(decimalsOf(step), decimalsOf(min));
  return Number((Math.round((v - min) / step) * step + min).toFixed(decimals));
}

function decimalsOf(n: number): number {
  return (String(n).split('.')[1] ?? '').length;
}

/**
 * Marks the document while a slider is dragged or a value scrubbed: `html[data-adjusting]`.
 * Overlays that must hide meanwhile (the cell probe) do so in CSS, with no wiring.
 */
export function setAdjusting(kind: 'drag' | 'scrub' | null): void {
  const root = document.documentElement;
  if (kind) root.dataset.adjusting = kind;
  else delete root.dataset.adjusting;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

export const PHONE_QUERY = '(max-width: 640px)';
/**
 * A window too short for the desktop stage's furniture (a phone in landscape is ~390 px tall): the
 * rulers, dimension lines and caption give way and the timeline compacts (stage.css, transport.css).
 */
export const SHORT_QUERY = '(min-width: 641px) and (max-height: 500px)';
