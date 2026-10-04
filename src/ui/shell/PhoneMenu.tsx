/**
 * Phones only (the ⋯ button in the top bar): one sheet with what the desktop spreads over the top
 * bar, the dock header and the stage header, which phones hide: undo / redo, Reset all,
 * the built-in and saved looks (and saving one, copying a settings link), Output / Split / Source (and what Split compares with), zoom,
 * the other ways in (paste, camera), closing the file, the Shortcuts sheet and the theme.
 *
 * It is the kit Dialog, so it is a bottom sheet with a focus trap and Escape. Actions that change
 * what the preview shows close the sheet so the result is visible; undo, redo and zoom keep it
 * open because they are often repeated.
 */
import { useState, type ReactNode } from 'react';
import { cameraAvailable, closeMedia, openCamera } from '../../app/controller';
import { copySettingsLink } from '../../app/permalink';
import { useStageLayout } from '../../app/engineHost';
import { BUILTIN_PRESETS, defaultParams, paramsEqual } from '../../state/params';
import { selectCanRedo, selectCanUndo, useStore, type CompareWith, type ViewMode } from '../../state/store';
import { applyPresetWithUndo, resetAllWithUndo } from '../inspector/presetActions';
import { PresetDialog, type PresetDialogMode } from '../inspector/PresetDialog';
import { Button, Dialog, IconButton, Segmented, type SegmentedOption } from '../kit';
import { effectiveCompare, rampCompareBlocked } from '../stage/compare';
import { fitView, formatZoom, zoomStep, zoomTo } from '../stage/viewActions';
import { pasteAndOpen } from '../start/openers';
import './PhoneMenu.css';

const VIEWS: readonly SegmentedOption<ViewMode>[] = [
  { value: 'output', label: 'Output' },
  { value: 'split', label: 'Split', icon: 'split' },
  { value: 'source', label: 'Source' },
];

const COMPARE: readonly SegmentedOption<CompareWith>[] = [
  { value: 'source', label: 'Original' },
  { value: 'ramp', label: 'Ramp' },
];

export default function PhoneMenu() {
  const [open, setOpen] = useState(false);
  const [presetDialog, setPresetDialog] = useState<PresetDialogMode | null>(null);
  const close = () => setOpen(false);
  const savePreset = () => {
    close();
    setPresetDialog('save');
  };
  return (
    <>
      <IconButton className="phone-only" icon="more" label="More" aria-haspopup="dialog" onClick={() => setOpen(true)} />
      <Dialog open={open} onClose={close} title="More" className="pm-sheet">
        <EditGroup />
        <ViewGroup onDone={close} />
        <ZoomGroup />
        <LooksGroup onDone={close} onSave={savePreset} />
        <SourceGroup onDone={close} />
        <AppGroup onDone={close} />
      </Dialog>
      {/* Outside the More sheet, which closes first; the same dialog as the dock's Presets menu. */}
      <PresetDialog mode={presetDialog} onClose={() => setPresetDialog(null)} />
    </>
  );
}

function Group({ title, aux, children }: { title: string; aux?: string; children: ReactNode }) {
  const id = `pm-${title.toLowerCase()}`;
  return (
    <section className="pm-grp" aria-labelledby={id}>
      <header className="sh">
        <h3 id={id}>{title}</h3>
        {aux && <span className="aux">{aux}</span>}
      </header>
      {children}
    </section>
  );
}

function EditGroup() {
  const canUndo = useStore(selectCanUndo);
  const canRedo = useStore(selectCanRedo);
  const atDefaults = useStore((s) => paramsEqual(s.params, defaultParams()));
  const { undo, redo } = useStore.getState();
  return (
    <Group title="Edit">
      <div className="pm-row">
        <Button icon="undo" disabled={!canUndo} onClick={undo}>
          Undo
        </Button>
        <Button icon="redo" disabled={!canRedo} onClick={redo}>
          Redo
        </Button>
        <Button icon="reset" disabled={atDefaults} onClick={resetAllWithUndo}>
          Reset all
        </Button>
      </div>
    </Group>
  );
}

function ViewGroup({ onDone }: { onDone(): void }) {
  const mode = useStore((s) => s.view.mode);
  const compareWith = useStore((s) => effectiveCompare(s.view, s.params));
  const rampBlocked = useStore((s) => rampCompareBlocked(s.params));
  const setView = useStore((s) => s.setView);
  return (
    <Group title="View">
      <Segmented
        kind="toggle"
        label="View"
        full
        options={VIEWS}
        value={mode}
        onChange={(m) => {
          setView({ mode: m });
          onDone();
        }}
      />
      {mode === 'split' && (
        <div className="pm-field">
          <span>Compare with</span>
          <Segmented
            label="Compare with"
            options={COMPARE.map((o) => (o.value === 'ramp' ? { ...o, disabled: rampBlocked !== null } : o))}
            value={compareWith}
            onChange={(c) => {
              setView({ compareWith: c });
              onDone();
            }}
          />
          {rampBlocked && <p className="pm-note">Ramp: {rampBlocked}</p>}
        </div>
      )}
    </Group>
  );
}

function ZoomGroup() {
  const layout = useStageLayout();
  return (
    <Group title="Zoom" aux={layout ? formatZoom(layout.zoom) : undefined}>
      <div className="pm-row">
        <Button icon="minus" disabled={!layout} onClick={() => zoomStep(-1)}>
          Out
        </Button>
        <Button icon="plus" disabled={!layout} onClick={() => zoomStep(1)}>
          In
        </Button>
        <Button icon="fit" disabled={!layout} onClick={fitView}>
          Fit
        </Button>
        <Button disabled={!layout} onClick={() => zoomTo(1)}>
          100%
        </Button>
      </div>
    </Group>
  );
}

function LooksGroup({ onDone, onSave }: { onDone(): void; onSave(): void }) {
  const userPresets = useStore((s) => s.userPresets);
  // The same feedback as the dock's Presets menu: a toast that says what changed, with Undo.
  const apply = (name: string) => {
    applyPresetWithUndo(name);
    onDone();
  };
  return (
    <Group title="Looks" aux="Presets">
      <div className="pm-grid">
        {BUILTIN_PRESETS.map((p) => (
          <Button key={p.name} onClick={() => apply(p.name)}>
            {p.name}
          </Button>
        ))}
        {userPresets.map((p) => (
          <Button key={`user:${p.name}`} onClick={() => apply(p.name)}>
            {p.name}
          </Button>
        ))}
      </div>
      <div className="pm-row pm-more">
        <Button icon="plus" onClick={onSave}>
          Save current…
        </Button>
        <Button
          icon="link"
          onClick={() => {
            onDone();
            void copySettingsLink();
          }}
        >
          Copy settings link
        </Button>
      </div>
    </Group>
  );
}

function SourceGroup({ onDone }: { onDone(): void }) {
  const info = useStore((s) => s.media.info);
  const then = (action: () => void) => () => {
    onDone();
    action();
  };
  return (
    <Group title="Source">
      <div className="pm-row">
        <Button icon="paste" onClick={then(pasteAndOpen)}>
          Paste
        </Button>
        {cameraAvailable() && (
          <Button icon="camera" onClick={then(() => void openCamera())}>
            Camera
          </Button>
        )}
        {info && (
          <Button icon="x" onClick={then(closeMedia)}>
            {info.live ? 'Stop camera' : 'Close file'}
          </Button>
        )}
      </div>
    </Group>
  );
}

function AppGroup({ onDone }: { onDone(): void }) {
  const showShortcuts = () => {
    onDone();
    useStore.getState().setUi({ shortcutsOpen: true });
  };
  return (
    <Group title="App">
      <Button icon="keyboard" stretch="wide" onClick={showShortcuts}>
        Keyboard shortcuts
      </Button>
    </Group>
  );
}
