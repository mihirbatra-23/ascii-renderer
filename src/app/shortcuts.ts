/**
 * One keyboard-action registry for the global keydown listener and the Shortcuts sheet.
 *
 *   registerShortcut({ id, label, group, keys: ['mod+e'], handler, enabled })  → unregister()
 *   updateShortcut(id, { handler })      attach / replace a handler later (screens own some)
 *   useShortcuts()                       live list for the overlay
 *   formatCombo('shift+mod+z')           '⇧⌘Z' on Apple platforms, 'Ctrl+Shift+Z' elsewhere
 *   installShortcutListener()            the window keydown listener (App mounts it once)
 *
 * Combo syntax: modifiers `mod` (⌘ on Apple, Ctrl elsewhere), `shift`, `alt`, then one key:
 * a character ('o', '[', '?', ','), or a key name ('space', 'escape', 'enter', 'arrowleft').
 *
 * Shortcuts never fire while typing in a text field (unless `inInputs`), and keys a focused
 * control uses itself (Space / Enter on buttons, arrows on sliders, radios and tabs) stay with it.
 */
import { useSyncExternalStore } from 'react';

export type ShortcutGroup = 'File' | 'Edit' | 'View' | 'Render' | 'Playback' | 'Start' | 'General';

export interface ShortcutAction {
  id: string;
  label: string;
  group: ShortcutGroup;
  /** First combo is the one shown; the rest are alternates. */
  keys: readonly string[];
  handler?(e: KeyboardEvent): void;
  /** Checked at key time; false leaves the key to the browser. */
  enabled?(): boolean;
  /** Fire even while a text field has focus (⌘O, ⌘E). */
  inInputs?: boolean;
  /** Fire on key auto-repeat (stepping actions); toggles ignore repeats. */
  repeat?: boolean;
  /** Listed in the overlay but handled elsewhere (e.g. ⌘V via the paste event). */
  displayOnly?: boolean;
}

// ---------------------------------------------------------------- registry

const actions = new Map<string, ShortcutAction>();
let snapshot: ShortcutAction[] = [];
const listeners = new Set<() => void>();

function changed() {
  snapshot = [...actions.values()];
  listeners.forEach((fn) => fn());
}

/** Adds or replaces the action with this id; returns a function that removes it again. */
export function registerShortcut(action: ShortcutAction): () => void {
  actions.set(action.id, action);
  changed();
  return () => {
    if (actions.get(action.id) === action) {
      actions.delete(action.id);
      changed();
    }
  };
}

export function updateShortcut(id: string, patch: Partial<Omit<ShortcutAction, 'id'>>): void {
  const current = actions.get(id);
  if (!current) return;
  actions.set(id, { ...current, ...patch });
  changed();
}

export function getShortcuts(): readonly ShortcutAction[] {
  return snapshot;
}

export function useShortcuts(): readonly ShortcutAction[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
  );
}

// ---------------------------------------------------------------- combos

export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** Keys whose character changes with Shift on common layouts: matched by physical code. */
const BY_CODE: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight' };

const comboCache = new Map<string, Combo>();

function parseCombo(text: string): Combo {
  let c = comboCache.get(text);
  if (!c) {
    const parts = text.toLowerCase().split('+');
    const key = parts.pop() ?? '';
    c = { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
    comboCache.set(text, c);
  }
  return c;
}

function matches(e: KeyboardEvent, text: string): boolean {
  const c = parseCombo(text);
  const mod = IS_APPLE ? e.metaKey : e.ctrlKey;
  const otherMod = IS_APPLE ? e.ctrlKey : e.metaKey;
  if (mod !== c.mod || otherMod || e.altKey !== c.alt) return false;
  // '?' is Shift + '/' on most layouts: match the character, whatever Shift took to type it.
  if (c.key === '?') return e.key === '?';
  if (e.shiftKey !== c.shift) return false;
  if (BY_CODE[c.key]) return e.code === BY_CODE[c.key];
  if (c.key === 'space') return e.key === ' ' || e.code === 'Space';
  return e.key.toLowerCase() === c.key;
}

const KEY_LABELS: Record<string, string> = {
  space: 'Space',
  escape: 'Esc',
  enter: '↵',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  backspace: '⌫',
};

/** Display form of a combo: '⇧⌘Z' (Apple) / 'Ctrl+Shift+Z'. */
export function formatCombo(text: string): string {
  const c = parseCombo(text);
  const key = KEY_LABELS[c.key] ?? c.key.toUpperCase();
  if (IS_APPLE) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`;
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

/** The first combo of an action, formatted; '' when the action is unknown. */
export function shortcutLabel(id: string): string {
  const keys = actions.get(id)?.keys;
  return keys?.length ? formatCombo(keys[0]) : '';
}

// ---------------------------------------------------------------- listener

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', 'date', 'time']);
const ACTIVATE_KEYS = new Set([' ', 'Enter']);
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const NAV_ROLES = '[role="slider"],[role="radio"],[role="tab"],[role="option"],[role^="menuitem"],[role="listbox"],[role="menu"]';

function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable;
}

/** The focused control handles this key itself (activation or arrow navigation); ⌘↵ and the like stay shortcuts. */
function controlOwnsKey(el: Element, e: KeyboardEvent): boolean {
  const modified = e.metaKey || e.ctrlKey || e.altKey;
  if (ACTIVATE_KEYS.has(e.key) && !modified && el.matches('button,a[href],summary,input:not([type="range"]),[role="button"],[role="switch"]')) return true;
  return NAV_KEYS.has(e.key) && (el.matches('input[type="range"]') || !!el.closest(NAV_ROLES));
}

export function dispatchShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const target = e.target instanceof Element ? e.target : null;
  // A modal dialog (Shortcuts sheet) handles its own keys; nothing behind it reacts.
  if (target?.closest('dialog[open]')) return false;
  const typing = !!target && isTextEntry(target);
  for (const action of snapshot) {
    if (action.displayOnly || !action.handler) continue;
    if (!action.keys.some((k) => matches(e, k))) continue;
    if (typing && !action.inInputs) continue;
    if (!typing && target && controlOwnsKey(target, e)) continue;
    if (action.enabled && !action.enabled()) continue;
    e.preventDefault();
    if (e.repeat && !action.repeat) return true;
    action.handler(e);
    return true;
  }
  return false;
}

export function installShortcutListener(): () => void {
  window.addEventListener('keydown', dispatchShortcut);
  return () => window.removeEventListener('keydown', dispatchShortcut);
}
