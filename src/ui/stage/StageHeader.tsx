/**
 * Stage header (spec §2): the view switch (Output / Split / Source, aria-pressed buttons), what
 * Split compares with, an optional context label, then the Rulers toggle, the zoom group
 * (− 75% +) and Fit. 48 px, so its hairline lines up with the dock header's.
 *
 * While Export is open the rulers give way to dimension lines (the toggle reads off) and the
 * zoom reads against the export size: 75% on screen at 2× shows as 37.5%.
 *
 * The header follows the stage's own width (container queries in stage.css), not the window's:
 * on a narrow stage the view switch and Fit drop their words for icons (names stay as labels).
 */
import { useEffect } from 'react';
import { useStageLayout } from '../../app/engineHost';
import { registerShortcut, shortcutLabel } from '../../app/shortcuts';
import { useStore, type CompareWith, type ViewMode } from '../../state/store';
import { Icon, type IconName } from '../icons';
import { Button, IconButton, MenuButton, MODE_LABELS, Segmented, Tooltip, type SegmentedOption } from '../kit';
import { effectiveCompare, rampCompareBlocked } from './compare';
import { exportPreview } from './exportSize';
import { formatScale } from './format';
import { fitView, formatZoom, zoomLimits, zoomStep } from './viewActions';

/** The icon shows only on a narrow stage, except Split's, which the board always draws. */
function ViewLabel({ icon, text, iconAlways }: { icon: IconName; text: string; iconAlways?: boolean }) {
  return (
    <>
      <Icon name={icon} className={iconAlways ? undefined : 'vw-i'} />
      <span className="vw-l">{text}</span>
    </>
  );
}

const VIEWS: readonly SegmentedOption<ViewMode>[] = [
  { value: 'output', label: <ViewLabel icon="type" text="Output" />, ariaLabel: 'Output' },
  { value: 'split', label: <ViewLabel icon="split" text="Split" iconAlways />, ariaLabel: 'Split' },
  { value: 'source', label: <ViewLabel icon="image" text="Source" />, ariaLabel: 'Source' },
];

const COMPARE_LABELS: Record<CompareWith, string> = { source: 'Original', ramp: 'Ramp' };

export default function StageHeader() {
  const mode = useStore((s) => s.view.mode);
  const setView = useStore((s) => s.setView);
  useZoomShortcuts();
  return (
    <div className="sbar">
      <Segmented kind="toggle" label="View" className="views" options={VIEWS} value={mode} onChange={(m) => setView({ mode: m })} />
      {mode === 'split' && <CompareMenu />}
      <ExportLabel />
      <span className="sp" />
      <RulersToggle />
      <ZoomGroup />
      <Tooltip label="Fit to stage" shortcut={shortcutLabel('view.fit')}>
        <Button variant="ghost" icon="fit" className="fit-b" aria-label="Fit to stage" onClick={fitView}>
          <span className="fit-l">Fit</span>
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * What the left of the Split shows: the untouched source (default) or a plain Ramp render of it,
 * which shows what the current mode adds over the classic density ramp. When the output is itself
 * a plain Ramp render the option is disabled with the reason, and the split shows the original.
 *
 * The trigger's accessible name starts with its visible text ("vs Original", WCAG 2.5.3); on a
 * narrow stage only "vs" shows (stage.css), which the name still starts with.
 */
function CompareMenu() {
  const params = useStore((s) => s.params);
  const view = useStore((s) => s.view);
  const compareWith = effectiveCompare(view, params);
  const blocked = rampCompareBlocked(params);
  const choose = (c: CompareWith) => {
    useStore.getState().setView({ compareWith: c });
    useStore.getState().announce(`Split compares ${MODE_LABELS[params.mode]} with ${c === 'ramp' ? 'a Ramp render' : 'the original'}`);
  };
  return (
    <MenuButton
      label={
        <span className="cmp-l">
          vs <span className="cmp-w">{COMPARE_LABELS[compareWith]}</span>
          <span className="sr">(what Split compares with)</span>
        </span>
      }
      align="start"
      width={240}
      className="cmp-b"
      items={[
        { heading: 'Left of the split' },
        { id: 'source', label: 'Original', aux: 'source', checked: compareWith === 'source', onSelect: () => choose('source') },
        {
          id: 'ramp',
          label: 'Ramp render',
          aux: 'density only',
          checked: compareWith === 'ramp',
          disabled: blocked !== null,
          note: blocked ?? undefined,
          onSelect: () => choose('ramp'),
        },
      ]}
    />
  );
}

function ExportLabel() {
  const layout = useStageLayout();
  const exportUi = useStore((s) => (s.exportUi.open ? s.exportUi : null));
  if (!exportUi) return null;
  const scale = layout ? exportPreview(layout, exportUi).scale : 1;
  return <span className="lbl">Export preview · {formatScale(scale)}</span>;
}

/**
 * While Export is open the dimension lines take the rulers' place, so the toggle reads off (as on
 * the board); it still flips the preference, which shows once Export closes (same as R).
 */
function RulersToggle() {
  const rulers = useStore((s) => s.view.rulers);
  const exporting = useStore((s) => s.exportUi.open);
  const toggle = () => {
    const { setView, announce } = useStore.getState();
    setView({ rulers: !rulers });
    announce(exporting ? `Rulers ${rulers ? 'off' : 'on'} after export` : `Rulers ${rulers ? 'off' : 'on'}`);
  };
  return (
    <IconButton
      icon="grid"
      label={exporting ? `Rulers: ${rulers ? 'on' : 'off'} after export` : 'Rulers'}
      shortcut={shortcutLabel('view.rulers')}
      pressed={rulers && !exporting}
      onClick={toggle}
    />
  );
}

/**
 * The readout is plain text, not a live region: it follows the fit zoom on every Columns change,
 * which would chatter. Explicit zoom actions announce themselves (viewActions).
 */
function ZoomGroup() {
  const layout = useStageLayout();
  const exportUi = useStore((s) => (s.exportUi.open ? s.exportUi : null));
  const limits = layout ? zoomLimits(layout) : null;
  const scale = layout && exportUi ? exportPreview(layout, exportUi).scale : 1;
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <Tooltip label="Zoom out" shortcut="−">
        <button type="button" aria-label="Zoom out" disabled={!layout || layout.zoom <= limits!.min * 1.001} onClick={() => zoomStep(-1)}>
          <Icon name="minus" />
        </button>
      </Tooltip>
      <span className="zoom-v">{layout ? formatZoom(layout.zoom, scale) : '–'}</span>
      <Tooltip label="Zoom in" shortcut="=">
        <button type="button" aria-label="Zoom in" disabled={!layout || layout.zoom >= limits!.max * 0.999} onClick={() => zoomStep(1)}>
          <Icon name="plus" />
        </button>
      </Tooltip>
    </div>
  );
}

/** − and = step the zoom (the default map has Fit and Actual size; these complete it). */
function useZoomShortcuts() {
  useEffect(() => {
    const offIn = registerShortcut({ id: 'view.zoomIn', label: 'Zoom in', group: 'View', keys: ['='], repeat: true, handler: () => zoomStep(1) });
    const offOut = registerShortcut({ id: 'view.zoomOut', label: 'Zoom out', group: 'View', keys: ['-'], repeat: true, handler: () => zoomStep(-1) });
    return () => {
      offIn();
      offOut();
    };
  }, []);
}
