/**
 * Horizontal scrubbing for value fields and slider labels (spec §5): drag sideways to change a
 * number, 1 px = 0.5% of the range, Shift = 0.05%. Movement under 3 px counts as a tap.
 *
 * Touch and pen scrub only once the finger has clearly gone sideways (./gesture), so a vertical
 * swipe that starts on a label scrolls the phone sheet instead. A gesture the browser takes over
 * (pointercancel) puts the value back where it was.
 */
import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { readIntent, TOUCH_SLOP_PX, waitsForIntent } from './gesture';
import { clamp, setAdjusting, snap } from './util';

const TAP_SLOP_PX = 3;
const COARSE = 0.005;
const FINE = 0.0005;

export interface ScrubOptions {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange(value: number): void;
  /** Gesture end (pointerup after a scrub, or a cancelled scrub once its value is restored). */
  onCommit?(): void;
  /** Pointer released without scrubbing. */
  onTap?(): void;
}

export function useScrub(options: ScrubOptions) {
  const ref = useRef(options);
  useLayoutEffect(() => {
    ref.current = options;
  });

  return useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const start = ref.current;
    if (start.disabled || e.button !== 0) return;
    // Keeps the browser from focusing / selecting text; a tap focuses explicitly via onTap.
    e.preventDefault();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    el.setPointerCapture(pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const slop = waitsForIntent(e.pointerType) ? TOUCH_SLOP_PX : TAP_SLOP_PX;
    let lastX = startX;
    let raw = start.value;
    let current = start.value;
    let scrubbing = false;

    const move = (ev: PointerEvent) => {
      if (!scrubbing) {
        // A mouse scrubs on any sideways movement; a finger must also mean it (not a scroll).
        const intent = readIntent(ev.clientX - startX, waitsForIntent(ev.pointerType) ? ev.clientY - startY : 0, slop);
        if (intent === 'pending') return;
        if (intent === 'scroll') return detach();
        scrubbing = true;
        setAdjusting('scrub');
      }
      const { min, max, step, onChange } = ref.current;
      raw = clamp(raw + (ev.clientX - lastX) * (max - min) * (ev.shiftKey ? FINE : COARSE), min, max);
      lastX = ev.clientX;
      const next = snap(raw, min, step);
      if (next !== current) {
        current = next;
        onChange(next);
      }
    };
    const detach = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', cancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      if (scrubbing) setAdjusting(null);
    };
    const release = () => {
      detach();
      if (scrubbing) ref.current.onCommit?.();
      else ref.current.onTap?.();
    };
    const cancel = () => {
      detach();
      if (!scrubbing || current === start.value) return;
      ref.current.onChange(start.value);
      // Closes the gesture; with the value restored it leaves no history entry.
      ref.current.onCommit?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', cancel);
  }, []);
}
