/**
 * The Export panel (spec §4.4–4.5): replaces the Adjust dock while open (App cross-fades the
 * swap). Header with back (Esc), Format / Size / Options in the scrolling body, and the sticky
 * footer with Download ⌘↵. Sizes come from the engine's real geometry (./sizing).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { registerDefaultShortcuts } from '../../app/defaultShortcuts';
import { updateShortcut } from '../../app/shortcuts';
import { useStore } from '../../state/store';
import { IconButton } from '../kit';
import { useExportEstimate } from './estimate';
import ExportFooter from './ExportFooter';
import { activeRecording, runExport, stopRecording } from './exportJob';
import FormatSection, { useFormatDefault } from './FormatSection';
import OptionsSection from './OptionsSection';
import SizeSection from './SizeSection';
import { useExportPlan } from './sizing';
import './export-panel.css';

function useDownloadShortcut(): void {
  useEffect(() => {
    // Child effects run before App's; make sure the defaults exist before attaching the handler.
    registerDefaultShortcuts();
    // ⌘↵ downloads; while a camera records, it stops and saves the recording.
    updateShortcut('export.download', {
      handler: () => void (activeRecording() ? stopRecording() : runExport()),
      enabled: () => useStore.getState().job.status !== 'running' || activeRecording() !== null,
    });
    return () => updateShortcut('export.download', { handler: undefined, enabled: undefined });
  }, []);
}

/**
 * Focus follows the panel: on open it moves to the selected format (the panel's first decision;
 * otherwise it stays on the top bar's Export button, a dozen Tabs away at the end of the page).
 * Closing removes the focused control with the panel, so focus goes back to the Export button.
 */
function usePanelFocus(panelRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    // Next frame: useFormatDefault may switch a clip to its own format in this same commit.
    const raf = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('.fmt[aria-checked="true"]')?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        // The top bar's one primary button is Export (its Open menu also has aria-expanded).
        document.querySelector<HTMLElement>('.top .btn.primary[aria-expanded]')?.focus();
      }
    };
  }, [panelRef]);
}

export default function ExportPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  useFormatDefault();
  useDownloadShortcut();
  usePanelFocus(panelRef);
  const plan = useExportPlan();
  const estimate = useExportEstimate(plan);
  return (
    <div ref={panelRef} className="exp-panel">
      <ExportHeader />
      <div className="db">
        <FormatSection />
        <SizeSection plan={plan} estimate={estimate} />
        <OptionsSection plan={plan} />
      </div>
      <ExportFooter plan={plan} estimate={estimate} />
    </div>
  );
}

function ExportHeader() {
  const setExportUi = useStore((s) => s.setExportUi);
  const close = () => setExportUi({ open: false });
  return (
    <div className="dh">
      <IconButton icon="arrow-l" label="Back to Adjust" shortcut="Esc" onClick={close} />
      <h2>Export</h2>
      <IconButton icon="x" label="Close export" className="phone-only" onClick={close} />
    </div>
  );
}
