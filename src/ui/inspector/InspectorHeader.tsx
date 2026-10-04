/**
 * Dock header (desktop): "Adjust", the Presets menu (built-ins, saved presets, save, delete, and a
 * settings link to share the settings) and Reset all, both 32 px. Both bulk changes report with an Undo
 * (./presetActions); Reset all is disabled while nothing differs.
 */
import { useState } from 'react';
import { copySettingsLink } from '../../app/permalink';
import { BUILTIN_PRESETS, defaultParams, paramsEqual } from '../../state/params';
import { useStore } from '../../state/store';
import { Button, MenuButton, MODE_LABELS, type MenuEntry } from '../kit';
import { PresetDialog, type PresetDialogMode } from './PresetDialog';
import { applyPresetWithUndo, resetAllWithUndo } from './presetActions';

const DEFAULTS = defaultParams();

export function InspectorHeader() {
  const atDefaults = useStore((s) => paramsEqual(s.params, DEFAULTS));
  return (
    <div className="dh desk-only">
      <h2>Adjust</h2>
      <PresetsMenu />
      <Button
        variant="ghost"
        icon="reset"
        disabled={atDefaults}
        title={atDefaults ? 'Nothing to reset' : undefined}
        onClick={resetAllWithUndo}
      >
        Reset all
      </Button>
    </div>
  );
}

function PresetsMenu() {
  const userPresets = useStore((s) => s.userPresets);
  const [dialog, setDialog] = useState<PresetDialogMode | null>(null);

  const items: MenuEntry[] = [
    { heading: 'Built-in' },
    ...BUILTIN_PRESETS.map((p) => ({
      id: `builtin:${p.name}`,
      label: p.name,
      aux: p.params.mode ? MODE_LABELS[p.params.mode] : undefined,
      onSelect: () => applyPresetWithUndo(p.name),
    })),
  ];
  if (userPresets.length) {
    items.push('separator', { heading: 'Saved' });
    items.push(
      ...userPresets.map((p) => ({ id: `user:${p.name}`, label: p.name, aux: MODE_LABELS[p.params.mode], onSelect: () => applyPresetWithUndo(p.name) })),
    );
  }
  items.push('separator', { id: 'save', label: 'Save as preset…', onSelect: () => setDialog('save') });
  if (userPresets.length) items.push({ id: 'delete', label: 'Delete presets…', onSelect: () => setDialog('manage') });
  // A link carries the settings to another browser or person (presets stay in this one).
  items.push('separator', { id: 'link', label: 'Copy settings link', onSelect: () => void copySettingsLink() });

  return (
    <>
      <MenuButton label="Presets" items={items} align="end" />
      <PresetDialog mode={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
