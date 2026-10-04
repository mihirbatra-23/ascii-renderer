/**
 * Sliders (spec §5 "Slider row"). A native range input (opacity 0) carries focus, keyboard and
 * AT semantics; the drawn track (ticks, lit ticks, rail, fill, thumb) follows `--p`. Pointer
 * input is handled on the track itself so a click lands exactly under the cursor.
 *
 *   SliderTrack   the ticked track alone
 *   SliderRow     96 px label | track | 56 px value field  (Brightness, Contrast …)
 *   HeroSlider    label + big value on top, track with labelled majors below (Columns)
 *
 * onChange fires on every input (live preview, nothing committed); onCommit fires when the
 * gesture ends (pointerup, key released, value field committed) so history gets one entry.
 * A gesture the browser takes over (pointercancel, e.g. it starts scrolling) is undone, not kept.
 *
 * Touch and pen wait for intent (see ./gesture): a vertical swipe that starts on a track scrolls
 * the phone sheet and leaves the value alone; a sideways drag adjusts; a tap jumps on release.
 *
 * Keyboard on the track: ← → 1% of the range (Shift ×10), PageUp/Down 10%, Home / End,
 * Backspace / Delete reset to `defaultValue`. Double-click the label to reset; drag the label or
 * the value field sideways to scrub (Shift = fine).
 */
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { readIntent, TOUCH_SLOP_PX, waitsForIntent } from './gesture';
import { NumberField } from './NumberField';
import { useScrub } from './useScrub';
import { clamp, cx, setAdjusting, snap } from './util';

interface RangeProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  onCommit?(): void;
  defaultValue?: number;
  disabled?: boolean;
}

export interface SliderTrackProps extends RangeProps {
  id?: string;
  /** Spoken value, e.g. '+0.04' or '160 columns'. */
  valueText?: string;
  bipolar?: boolean;
  /** Values with a 9 px major tick; default is the two ends with minors every 10%. */
  majors?: readonly number[];
  /** Minor tick spacing in value units (with `majors`). */
  minorStep?: number;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

const pct = (v: number, min: number, max: number) => ((v - min) / (max - min)) * 100;

function tickBackground(min: number, max: number, majors: readonly number[], minorStep: number): string {
  const layers = majors.map((m) => `linear-gradient(var(--t),var(--t)) ${pct(m, min, max).toFixed(3)}% 100%/1px 9px no-repeat`);
  const minor = ((minorStep / (max - min)) * 100).toFixed(4);
  layers.push(`repeating-linear-gradient(90deg,var(--t) 0 1px,transparent 1px ${minor}%) 0 100%/calc(100% - 1px) 5px no-repeat`);
  return layers.join(',');
}

export function SliderTrack({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  defaultValue,
  disabled,
  id,
  valueText,
  bipolar,
  majors,
  minorStep,
  className,
  ...aria
}: SliderTrackProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const range = max - min;
  const snapped = (v: number) => snap(clamp(v, min, max), min, step);
  // Keyboard and AT: each key press re-renders, so `value` is current here.
  const set = (v: number) => {
    const next = snapped(v);
    if (next !== value) onChange(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    const rect = el.getBoundingClientRect();
    const fromX = (x: number) => min + clamp((x - rect.left) / rect.width, 0, 1) * range;
    const startX = e.clientX;
    const startY = e.clientY;
    // The value before the gesture, restored if the browser takes the pointer away.
    const startValue = value;
    // What this gesture last sent. The closure outlives the render it was made in, so comparing
    // against `value` would swallow a move back to the starting value.
    let last = value;
    let raw = startValue;
    let lastX = startX;
    let active = false;
    const emit = (v: number) => {
      const next = snapped(v);
      if (next !== last) {
        last = next;
        onChange(next);
      }
    };
    const begin = (x: number) => {
      active = true;
      inputRef.current?.focus({ preventScroll: true });
      el.setPointerCapture(pointerId);
      setDragging(true);
      setAdjusting('drag');
      raw = fromX(x);
      lastX = x;
      emit(raw);
    };

    const move = (ev: globalThis.PointerEvent) => {
      if (!active) {
        const intent = readIntent(ev.clientX - startX, ev.clientY - startY, TOUCH_SLOP_PX);
        if (intent === 'pending') return;
        // A scroll: the browser pans the sheet and ends the sequence with pointercancel.
        if (intent === 'scroll') return detach();
        return begin(ev.clientX);
      }
      // Shift: fine control relative to where the drag is, at a tenth of the speed.
      raw = ev.shiftKey ? clamp(raw + ((ev.clientX - lastX) / rect.width) * range * 0.1, min, max) : fromX(ev.clientX);
      lastX = ev.clientX;
      emit(raw);
    };
    const detach = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', cancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      if (active) {
        setDragging(false);
        setAdjusting(null);
      }
    };
    const release = (ev: globalThis.PointerEvent) => {
      detach();
      if (!active) {
        // A touch that never moved is a tap: jump to it, like a click.
        inputRef.current?.focus({ preventScroll: true });
        emit(fromX(ev.clientX));
      }
      onCommit?.();
    };
    const cancel = () => {
      const changed = active && last !== startValue;
      detach();
      if (!changed) return;
      onChange(startValue);
      // Closes the gesture; with the value restored it leaves no history entry.
      onCommit?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', cancel);
    if (!waitsForIntent(e.pointerType)) begin(startX);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const unit = range * 0.01 * (e.shiftKey ? 10 : 1);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + Math.max(unit, step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - Math.max(unit, step);
    else if (e.key === 'PageUp') next = value + range * 0.1;
    else if (e.key === 'PageDown') next = value - range * 0.1;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if ((e.key === 'Backspace' || e.key === 'Delete') && defaultValue !== undefined) next = defaultValue;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };

  const style: CSSProperties & Record<'--p', string> = { '--p': `${pct(value, min, max)}%` };
  const ticks = majors ? { background: tickBackground(min, max, majors, minorStep ?? range / 10) } : undefined;

  return (
    <div className={cx('trk', bipolar && 'bi', dragging && 'is-drag', className)} style={style} onPointerDown={onPointerDown}>
      <input
        ref={inputRef}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueText}
        {...aria}
        onChange={(e) => {
          // Only assistive tech reaches this path (keys and pointer are handled above).
          set(Number(e.currentTarget.value));
          onCommit?.();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={() => onCommit?.()}
      />
      <span className="ticks" style={ticks} />
      <span className="lit" style={ticks} />
      <span className="rail" />
      <span className="fill" />
      <span className="th" />
    </div>
  );
}

export interface SliderRowProps extends RangeProps {
  label: string;
  format?(value: number): string;
  parse?(text: string): number | null;
  bipolar?: boolean;
  id?: string;
}

function useResetAndScrub({ value, min, max, step, onChange, onCommit, defaultValue, disabled }: RangeProps) {
  const scrub = useScrub({ value, min, max, step, disabled, onChange, onCommit });
  const reset = () => {
    if (disabled || defaultValue === undefined || defaultValue === value) return;
    onChange(defaultValue);
    onCommit?.();
  };
  return { scrub, reset };
}

export function SliderRow(props: SliderRowProps) {
  const { label, format = String, parse, bipolar, id: idProp, ...range } = props;
  const autoId = useId();
  const id = idProp ?? autoId;
  const { scrub, reset } = useResetAndScrub(range);
  const { defaultValue: _reset, ...field } = range;
  return (
    <div className={cx('row', range.disabled && 'off')}>
      <label htmlFor={id} onPointerDown={scrub} onDoubleClick={reset}>
        {label}
      </label>
      <SliderTrack id={id} {...range} bipolar={bipolar} valueText={format(range.value)} />
      <NumberField {...field} format={format} parse={parse} aria-label={`${label} value`} />
    </div>
  );
}

export interface HeroSliderProps extends SliderRowProps {
  /** Unit after the value field, e.g. 'col'. */
  unit?: string;
  /** Labelled major ticks, e.g. [40, 100, 200, 300, 400]. */
  majors: readonly number[];
  minorStep: number;
}

export function HeroSlider(props: HeroSliderProps) {
  const { label, unit, majors, minorStep, format = String, parse, bipolar, id: idProp, ...range } = props;
  const autoId = useId();
  const id = idProp ?? autoId;
  const { scrub, reset } = useResetAndScrub(range);
  const { defaultValue: _reset, ...field } = range;
  return (
    <div className="slider-hero">
      <div className="colsrow">
        <label htmlFor={id} onPointerDown={scrub} onDoubleClick={reset}>
          {label}
        </label>
        <span className="bv">
          <NumberField {...field} big format={format} parse={parse} aria-label={`${label} value`} />
          {unit && <span className="unit">{unit}</span>}
        </span>
      </div>
      <SliderTrack
        id={id}
        {...range}
        className="cols"
        bipolar={bipolar}
        majors={majors}
        minorStep={minorStep}
        valueText={`${format(range.value)}${unit ? ` ${unit}` : ''}`}
      />
      <div className="scale" aria-hidden="true">
        {majors.map((m) => (
          <span key={m} style={{ left: `${pct(m, range.min, range.max).toFixed(3)}%` }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}
