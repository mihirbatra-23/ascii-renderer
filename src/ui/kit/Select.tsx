/**
 * Select + listbox (spec §5): a 32 px trigger showing the value, a mono aux and a chevron; the
 * 240 px listbox opens 4 px below. Keyboard: ↓ ↑ / Enter / Space open; in the list ↓ ↑ Home End
 * move, a letter jumps, Enter / Space choose, Escape closes. Focus returns to the trigger.
 *
 *   <Select label="Glyph set" value={preset} options={…} onChange={…} />
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Popover } from './Popover';
import { cx } from './util';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Right-aligned mono note (e.g. the glyph count). */
  aux?: string;
  /** Draw a hairline above this option (e.g. before "Custom…"). */
  separatorBefore?: boolean;
}

export interface SelectProps<T extends string> {
  value: NoInfer<T>;
  options: readonly SelectOption<T>[];
  onChange(value: NoInfer<T>): void;
  /** Accessible name; the trigger reads "<label>: <value>". */
  label: string;
  /** Mono note inside the trigger, before the chevron. */
  aux?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Select<const T extends string>({ value, options, onChange, label, aux, disabled, id, className }: SelectProps<T>) {
  const listId = useId();
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Keyboard users get an accent ring on the active option; pointer users only the highlight.
  const [keyboard, setKeyboard] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  const openList = (byKeyboard: boolean) => {
    setActive(selectedIndex);
    setKeyboard(byKeyboard);
    setOpen(true);
  };
  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    close(true);
  };

  useLayoutEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openList(true);
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = Math.min(last, active + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const order = [...options.keys()].map((j) => (active + 1 + j) % options.length);
      next = order.find((j) => options[j].label.toLowerCase().startsWith(k)) ?? null;
    }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setKeyboard(true);
    setActive(next);
  };

  return (
    <>
      <button
        ref={setTrigger}
        id={id}
        type="button"
        className={cx('select', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${selected?.label ?? ''}`}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList(false))}
        onKeyDown={onTriggerKey}
      >
        <span>{selected?.label}</span>
        {aux !== undefined && <span className="ct">{aux}</span>}
        <Icon name="chev-d" />
      </button>
      <Popover anchor={trigger} open={open} onClose={close}>
        <div
          ref={listRef}
          id={listId}
          className="menu listbox"
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          data-keyboard={keyboard || undefined}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <div key={o.value} role="presentation">
              {o.separatorBefore && <hr />}
              <div
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                onPointerMove={() => {
                  setKeyboard(false);
                  setActive(i);
                }}
                onClick={() => choose(i)}
              >
                <span className="ck">{o.value === value && <Icon name="check" />}</span>
                <span className="nm">{o.label}</span>
                {o.aux && <small>{o.aux}</small>}
              </div>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
