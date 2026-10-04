/**
 * Bulk settings changes with feedback, shared by the dock header and the phone's More sheet:
 * each says what happened in a toast whose Undo restores exactly the settings it replaced.
 *
 *   applyPresetWithUndo(name)   a built-in or saved preset
 *   resetAllWithUndo()          every parameter back to the theme's defaults
 */
import type { RenderParams } from '../../engine/types';
import { paramsEqual } from '../../state/params';
import { useStore } from '../../state/store';
import { MODE_LABELS, toast } from '../kit';
import { COLOR_LABELS } from './copy';

const store = () => useStore.getState();

const undoTo = (before: RenderParams) => ({ label: 'Undo', onClick: () => store().setParams(before) });

export function resetAllWithUndo(): void {
  const before = store().params;
  store().resetParams();
  if (paramsEqual(before, store().params)) {
    toast({ icon: 'reset', title: 'Nothing to reset', body: 'All settings are already at their defaults.' });
    return;
  }
  toast({ icon: 'reset', title: 'Settings reset', body: 'All settings are back to their defaults.', trailing: undoTo(before) });
}

export function applyPresetWithUndo(name: string): void {
  const before = store().params;
  store().applyPreset(name);
  const after = store().params;
  if (paramsEqual(before, after)) {
    toast({ title: `${name} is already applied`, body: 'Nothing changed.' });
    return;
  }
  toast({
    icon: 'check',
    title: `Applied ${name}`,
    body: `${MODE_LABELS[after.mode]} · ${COLOR_LABELS[after.colorMode]}. Other settings are unchanged.`,
    trailing: undoTo(before),
  });
}
