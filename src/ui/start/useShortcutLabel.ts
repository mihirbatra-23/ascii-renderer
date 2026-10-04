import { formatCombo, useShortcuts } from '../../app/shortcuts';

/**
 * The displayed combo of a registered action ('⌘O' / 'Ctrl+O'), live from the registry.
 * `fallback` covers the first frame: App registers the defaults in an effect that runs after
 * this screen's first render, and the kbd chips must not pop in a frame late.
 */
export function useShortcutLabel(id: string, fallback: string): string {
  const key = useShortcuts().find((a) => a.id === id)?.keys[0];
  return formatCombo(key ?? fallback);
}
