/**
 * localStorage persistence for user preferences. Every access is guarded: storage can be missing,
 * blocked or full (private windows, previews), and the app must work without it.
 */
const KEY = 'ascii-renderer:v1';

export function readPersisted(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced so a slider drag writes once when it settles, not on every input event. */
export function writePersisted(value: unknown): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(value));
    } catch {
      // Quota or access errors: preferences simply are not remembered this session.
    }
  }, 300);
}
