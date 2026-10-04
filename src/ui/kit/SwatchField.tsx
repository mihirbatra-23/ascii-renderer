/**
 * Colour swatch (spec §5): a 40 px tile with a 16 px chip, the name and the hex value. It opens the
 * 240 px colour popover (./ColorPicker: saturation / brightness plane, hue strip, hex field), the
 * same in every browser. Changes preview live (onChange); each drag, key press or hex entry ends
 * with onCommit, and so does closing the popover.
 *
 *   <SwatchField label="Ink" value={ink} onChange={(v) => setParam('ink', v, { commit: false })} onCommit={commitParams} />
 */
import { useState, type KeyboardEvent } from 'react';
import { ColorPicker } from './ColorPicker';
import { Popover } from './Popover';
import { cx } from './util';

export interface SwatchFieldProps {
  label: string;
  /** #rrggbb */
  value: string;
  onChange(value: string): void;
  onCommit?(): void;
  disabled?: boolean;
  className?: string;
}

/** Tab and Shift+Tab stay inside the popover (Escape closes it and returns to the swatch). */
function cycleFocus(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[tabindex="0"],input'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

export function SwatchField({ label, value, onChange, onCommit, disabled, className }: SwatchFieldProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const hex = value.replace('#', '').toUpperCase();
  const close = (focusSwatch: boolean) => {
    setOpen(false);
    onCommit?.();
    if (focusSwatch) anchor?.focus();
  };
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={cx('swatch', disabled && 'off', className)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} colour ${hex}`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span className="c" style={{ background: value }} />
        <span className="n">{label}</span>
        <span className="h">{hex}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={close} closeOnTab={false}>
        <div className="cpop" role="dialog" aria-label={`${label} colour`} onKeyDown={cycleFocus}>
          <ColorPicker label={label} value={value} onChange={onChange} onCommit={onCommit} />
        </div>
      </Popover>
    </>
  );
}
