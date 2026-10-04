/**
 * Keyboard model for radiogroups and tablists (WAI-ARIA): one tab stop (the checked item),
 * arrow keys move and select, Home / End jump to the ends. Selection follows focus by clicking
 * the newly focused item, so each item's own onClick stays the single code path.
 */
import type { KeyboardEvent } from 'react';

const NEXT = new Set(['ArrowRight', 'ArrowDown']);
const PREV = new Set(['ArrowLeft', 'ArrowUp']);

export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>, itemSelector = '[role="radio"]'): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(itemSelector)).filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (NEXT.has(e.key)) next = (i + 1) % items.length;
  else if (PREV.has(e.key)) next = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else return;
  e.preventDefault();
  // The global shortcut map also binds arrows (frame step); a handled arrow stops here.
  e.stopPropagation();
  items[next].focus();
  items[next].click();
}

/** tabIndex for item `i` of a roving group: the checked item, or the first when none is. */
export function rovingTabIndex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1;
}
