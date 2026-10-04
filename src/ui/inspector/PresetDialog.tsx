/**
 * The Presets menu's two dialogs. Presets live in this browser (persisted with the settings).
 *
 *   mode 'save'     name the current settings (focus in the name field; Enter or the footer's Save saves)
 *   mode 'manage'   "Delete presets": the list with a delete button per preset, focus on the first
 *                   one, and no save form, so Enter can never save when the user came to delete
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BUILTIN_PRESETS } from '../../state/params';
import { useStore } from '../../state/store';
import { Button, Dialog, IconButton, MODE_LABELS, TextField, toast } from '../kit';
import { store } from './controls';

export type PresetDialogMode = 'save' | 'manage';

export function PresetDialog({ mode, onClose }: { mode: PresetDialogMode | null; onClose(): void }) {
  const formId = useId();
  const userPresets = useStore((s) => s.userPresets);
  const [name, setName] = useState('');
  // A fresh default name each time the save dialog opens (set while rendering, before it shows).
  const [shownMode, setShownMode] = useState<PresetDialogMode | null>(null);
  if (mode !== shownMode) {
    setShownMode(mode);
    if (mode === 'save') setName(`Preset ${userPresets.length + 1}`);
  }
  const trimmed = name.trim();
  const builtin = BUILTIN_NAMES.has(trimmed.toLowerCase());
  const footer =
    mode === 'save' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" disabled={!trimmed || builtin}>
          Save
        </Button>
      </>
    ) : undefined;
  return (
    <Dialog open={mode !== null} onClose={onClose} title={mode === 'manage' ? 'Delete presets' : 'Save preset'} className="preset-dlg" footer={footer}>
      {mode === 'save' && <PresetForm id={formId} name={name} onNameChange={setName} onSaved={onClose} />}
      {mode === 'manage' && <YourPresets />}
    </Dialog>
  );
}

const BUILTIN_NAMES = new Set(BUILTIN_PRESETS.map((p) => p.name.toLowerCase()));

/** Runs once the dialog has opened: showModal happens in the Dialog's effect, after its children's. */
function useAfterOpen(fn: () => void): void {
  useEffect(() => {
    const raf = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(raf);
    // Once per opening; `fn` only reads refs.
  }, []);
}

/** The name field; Save lives in the dialog footer and submits this form (form={id}), so Enter saves. */
function PresetForm({ id, name, onNameChange, onSaved }: { id: string; name: string; onNameChange(name: string): void; onSaved(): void }) {
  const fieldId = useId();
  const userPresets = useStore((s) => s.userPresets);
  const inputRef = useRef<HTMLInputElement>(null);
  useAfterOpen(() => inputRef.current?.select());

  const trimmed = name.trim();
  const builtin = BUILTIN_NAMES.has(trimmed.toLowerCase());
  const replaces = userPresets.some((p) => p.name === trimmed);
  const hint = builtin
    ? 'A built-in preset has this name. Choose another.'
    : replaces
      ? 'Replaces the saved preset with this name.'
      : 'Saved in this browser only.';

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || builtin) return;
    store().savePreset(trimmed);
    toast({ kind: 'success', title: `Saved preset “${trimmed}”`, body: 'It’s in the Presets menu.' });
    onSaved();
  };

  return (
    <form id={id} className="pform" onSubmit={save}>
      <label className="flabel" htmlFor={fieldId}>
        Name
      </label>
      <TextField ref={inputRef} id={fieldId} value={name} maxLength={40} onChange={(e) => onNameChange(e.currentTarget.value)} />
      <p className="hint">{hint}</p>
    </form>
  );
}

function YourPresets() {
  const userPresets = useStore((s) => s.userPresets);
  const listRef = useRef<HTMLUListElement>(null);
  const deleteButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  useAfterOpen(() => deleteButtons()[0]?.focus());

  const remove = (name: string, index: number) => {
    store().deletePreset(name);
    store().announce(`Preset ${name} deleted.`);
    // The pressed button is gone with its row: keep focus in the list, on the row that took its place.
    requestAnimationFrame(() => {
      const buttons = deleteButtons();
      buttons[Math.min(index, buttons.length - 1)]?.focus();
    });
  };

  if (!userPresets.length) return <p className="hint flush">No saved presets.</p>;
  return (
    <ul ref={listRef} className="plist">
      {userPresets.map((p, i) => (
        <li key={p.name}>
          <span className="nm">{p.name}</span>
          <small>
            {MODE_LABELS[p.params.mode]} · {p.params.columns} col
          </small>
          <IconButton icon="x" size="sm" label={`Delete preset ${p.name}`} tooltip={false} onClick={() => remove(p.name, i)} />
        </li>
      ))}
    </ul>
  );
}
