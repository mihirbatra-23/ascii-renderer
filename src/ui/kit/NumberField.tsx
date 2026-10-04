/**
 * Boxed, scrubbable value field (spec §5 `.val`): drag sideways to scrub, click (or Tab in) to
 * type, Enter commits (⌘↵ commits and still reaches its global shortcut), Escape reverts,
 * ↑ ↓ step (Shift ×10). Out-of-range or unparsable input
 * reverts / clamps silently; a number field never shows an error state.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useScrub } from './useScrub';
import { clamp, cx, snap } from './util';

export interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  /** Gesture end: scrub released, Enter, blur, arrow key released. */
  onCommit?(): void;
  format?(value: number): string;
  parse?(text: string): number | null;
  /** The 72 × 32 px, 18 px hero variant (Columns). */
  big?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/** Accepts the typographic minus our formatters emit, a leading '+', a comma decimal and trailing units. */
export function parseNumber(text: string): number | null {
  const n = Number.parseFloat(text.trim().replace('−', '-').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function NumberField({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  format = String,
  parse = parseNumber,
  big,
  disabled,
  id,
  className,
  ...aria
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // null while not editing: the field then shows the formatted store value.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  // Select the text once React has written a new draft (after Enter / Escape), so typing replaces it.
  const selectNext = useRef(false);
  useLayoutEffect(() => {
    if (!selectNext.current) return;
    selectNext.current = false;
    inputRef.current?.select();
  });
  const showDraft = (text: string) => {
    if (inputRef.current?.value === text) return inputRef.current.select();
    selectNext.current = true;
    setDraft(text);
  };

  const scrub = useScrub({
    value,
    min,
    max,
    step,
    disabled: disabled || editing,
    onChange,
    onCommit,
    onTap: () => inputRef.current?.focus(),
  });

  const apply = (next: number) => {
    const v = snap(clamp(next, min, max), min, step);
    if (v !== value) onChange(v);
    return v;
  };

  const commitText = (text: string) => {
    if (text === format(value)) return value;
    const n = parse(text);
    const v = n === null ? value : apply(n);
    onCommit?.();
    return v;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.altKey)) {
      // A shortcut (⌘↵ downloads the export): commit what was typed so it acts on that value,
      // and leave the event to the global shortcut listener.
      setDraft(format(commitText(input.value)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      showDraft(format(commitText(input.value)));
    } else if (e.key === 'Escape') {
      // Handled here: the global Escape (close Export) must not fire while editing.
      e.stopPropagation();
      if (input.value !== format(value)) {
        showDraft(format(value));
      } else {
        input.blur();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parse(input.value) ?? value;
      const v = apply(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      setDraft(format(v));
    }
  };

  return (
    <input
      ref={inputRef}
      id={id}
      className={cx('val', big && 'big', className)}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      value={editing ? draft : format(value)}
      {...aria}
      onPointerDown={editing ? undefined : scrub}
      onMouseDown={(e) => !editing && e.preventDefault()}
      onFocus={(e) => {
        setDraft(format(value));
        e.currentTarget.select();
      }}
      onBlur={(e) => {
        commitText(e.currentTarget.value);
        setDraft(null);
      }}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onCommit?.()}
    />
  );
}
