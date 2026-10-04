/**
 * The swatch popover's picker (spec §5 "Swatch and color popover"): a saturation / brightness
 * plane, a hue strip and a hex field. Every change previews live (onChange); the end of a drag, a
 * key release or a committed hex value closes the gesture (onCommit), so one pick is one undo
 * entry.
 *
 * Keyboard: the plane is a 2D slider (← → saturation, ↑ ↓ brightness), the strip a slider (← →
 * hue); Shift moves ten times as far. Tab cycles plane → strip → field inside the popover.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from './color';
import { TextField } from './TextField';
import { clamp } from './util';

export interface ColorPickerProps {
  /** #rrggbb */
  value: string;
  onChange(hex: string): void;
  onCommit?(): void;
  /** What the color is for, e.g. 'Ink' (accessible names). */
  label: string;
}

/** Fractions of the control under the pointer (0..1 across, 0..1 down), for the whole drag. */
function trackPointer(e: PointerEvent<HTMLElement>, onMove: (x: number, y: number) => void, onEnd: () => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  el.focus({ preventScroll: true });
  el.setPointerCapture(e.pointerId);
  const rect = el.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number }) =>
    onMove(clamp((ev.clientX - rect.left) / rect.width, 0, 1), clamp((ev.clientY - rect.top) / rect.height, 0, 1));
  const move = (ev: globalThis.PointerEvent) => at(ev);
  const end = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    onEnd();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  at(e);
}

/** Arrow-key step for a 0..1 axis: 1%, Shift 10%. */
const step = (e: KeyboardEvent) => (e.shiftKey ? 0.1 : 0.01);
const pct = (v: number) => Math.round(v * 100);

export function ColorPicker({ value, onChange, onCommit, label }: ColorPickerProps) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  // A change from outside (undo, theme switch, the hex field) moves the picker; its own changes
  // come back as the same hex and keep the hue it was dragged to.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== hsvToHex(hsv)) setHsv(hexToHsv(value));
  }

  // The value as last sent or received. A drag's handlers outlive the render they were made in,
  // so comparing against `value` there would swallow a move back to the starting color.
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  const apply = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    if (hex === latest.current) return;
    latest.current = hex;
    onChange(hex);
  };
  const commit = () => onCommit?.();

  const onPlaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = step(e);
    const moves: Record<string, Partial<Hsv>> = {
      ArrowRight: { s: hsv.s + d },
      ArrowLeft: { s: hsv.s - d },
      ArrowUp: { v: hsv.v + d },
      ArrowDown: { v: hsv.v - d },
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    apply({ ...hsv, s: clamp(m.s ?? hsv.s, 0, 1), v: clamp(m.v ?? hsv.v, 0, 1) });
  };
  const onHueKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0);
    if (!d) return;
    e.preventDefault();
    apply({ ...hsv, h: clamp(hsv.h + d, 0, 360) });
  };

  // Opening the popover puts the keyboard on the plane (the popover only exists while open).
  const planeRef = useRef<HTMLDivElement>(null);
  useEffect(() => planeRef.current?.focus({ preventScroll: true }), []);

  const style = { '--h': hsv.h, '--x': `${hsv.s * 100}%`, '--y': `${(1 - hsv.v) * 100}%`, '--hx': `${(hsv.h / 360) * 100}%` } as CSSProperties;
  return (
    <div className="cpick" style={style}>
      <div
        ref={planeRef}
        className="cp-sv"
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct(hsv.v)}
        aria-valuetext={`Saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%`}
        onPointerDown={(e) => trackPointer(e, (x, y) => apply({ ...hsv, s: x, v: 1 - y }), commit)}
        onKeyDown={onPlaneKey}
        onKeyUp={commit}
      >
        <span className="k" />
      </div>
      <div
        className="cp-hue"
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        onPointerDown={(e) => trackPointer(e, (x) => apply({ ...hsv, h: x * 360 }), commit)}
        onKeyDown={onHueKey}
        onKeyUp={commit}
      >
        <span className="k" />
      </div>
      <HexField value={value} label={label} onChange={onChange} onCommit={commit} />
    </div>
  );
}

/** The hex value as text: applied on Enter or when leaving the field; anything that is not a color reverts. */
function HexField({ value, label, onChange, onCommit }: { value: string; label: string; onChange(hex: string): void; onCommit(): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value.slice(1).toUpperCase();
  const apply = (text: string) => {
    setDraft(null);
    const hex = normalizeHex(text);
    if (!hex || hex === value) return;
    onChange(hex);
    onCommit();
  };
  return (
    <TextField
      prefix="#"
      fieldClassName="cp-hex"
      aria-label={`${label} hex value`}
      maxLength={7}
      value={draft ?? shown}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => apply(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        apply(e.currentTarget.value);
      }}
    />
  );
}
