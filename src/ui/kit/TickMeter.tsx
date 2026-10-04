/**
 * Tick meter (spec §5 progress): 16 px, 2 px ticks on a 5 px pitch, filled ticks in accent.
 * `value === null` is indeterminate (a 25% window sliding at 1.2 s); with reduced motion the
 * window is replaced by static text ("Loading…", or what `busyText` says the meter is doing).
 */
import type { CSSProperties } from 'react';
import { cx, useReducedMotion } from './util';

export interface TickMeterProps {
  /** 0..1, or null while the total is unknown. */
  value: number | null;
  /** Accessible name, e.g. 'Encoding progress'. */
  label: string;
  /** What an indeterminate meter is doing, spoken and shown with reduced motion (default 'Loading'). */
  busyText?: string;
  className?: string;
}

export function TickMeter({ value, label, busyText = 'Loading', className }: TickMeterProps) {
  const reduced = useReducedMotion();
  const indeterminate = value === null;
  const pct = indeterminate ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  const style = { '--v': `${pct ?? 0}%` } as CSSProperties;
  return (
    <div
      className={cx('meter', indeterminate && 'ind', className)}
      style={style}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={indeterminate ? busyText : `${pct}%`}
    >
      {indeterminate && reduced && <span className="meter-txt">{busyText}…</span>}
    </div>
  );
}
