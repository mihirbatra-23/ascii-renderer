/**
 * The shell (design spec §2): Start screen while nothing is open, else the editor grid:
 * top bar 48 / stage + dock / status bar 28, dock 336 px (304 at ≤ 1280), and on phones a single
 * column with a mode strip and the dock as a bottom sheet.
 *
 * The Start screen stays up while the first file loads (it shows the progress itself), so a file
 * that fails to open never flashes an empty editor and focus stays where the user left it.
 *
 * Screens live in src/ui/<area>/ and are mounted here only; App subscribes to just the few
 * fields that change the layout, so parameter edits never re-render the shell.
 */
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from 'react';
import { useDocumentTitle, useGlobalShortcuts, usePasteToOpen, useSettingsLinks, useThemeSync, useWindowFileDrop } from './app/hooks';
import { selectIsAnimated, useStore, type SheetDetent } from './state/store';
import Inspector from './ui/inspector/Inspector';
import { ModeTiles, SheetGrab, ToastHost, type SheetDetentSpec } from './ui/kit';
import DropOverlay from './ui/shell/DropOverlay';
import ShortcutsOverlay from './ui/shell/ShortcutsOverlay';
import StatusBar from './ui/shell/StatusBar';
import TopBar from './ui/shell/TopBar';
import Stage from './ui/stage/Stage';
import StageHeader from './ui/stage/StageHeader';
import StartScreen from './ui/start/StartScreen';
import Transport from './ui/transport/Transport';
import './ui/shell/shell.css';

// The export panel and the exporters behind it load on demand (they are most of the app's code);
// once a file is open they are fetched in idle time, so opening Export is still instant.
const loadExportPanel = () => import('./ui/export/ExportPanel');
const ExportPanel = lazy(loadExportPanel);

export default function App() {
  useThemeSync();
  useDocumentTitle();
  useGlobalShortcuts();
  useWindowFileDrop();
  usePasteToOpen();
  useSettingsLinks();
  const editing = useStore((s) => !!s.media.info);
  return (
    <>
      {editing ? <Editor /> : <Start />}
      <ShortcutsOverlay />
      <LiveRegion />
    </>
  );
}

function Start() {
  return (
    <>
      <StartScreen />
      <ToastHost placement="window" />
    </>
  );
}

function Editor() {
  const animated = useStore(selectIsAnimated);
  const loading = useStore((s) => s.media.status === 'loading');
  const stageRef = useRef<HTMLElement>(null);
  usePrefetchExport();

  // Opening from the start screen unmounts the button that had focus: continue from the preview.
  useEffect(() => {
    if (document.activeElement === document.body || !document.activeElement) stageRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="app">
      <TopBar />
      <PhoneModeStrip />
      <main ref={stageRef} className="stage" aria-label="Preview" aria-busy={loading} tabIndex={-1}>
        <StageHeader />
        <div className="stage-main">
          {loading && <div className="loadbar" aria-hidden="true" />}
          <Stage />
          <DropOverlay />
          <ToastHost />
        </div>
        {animated && <Transport />}
      </main>
      <Dock />
      <StatusBar />
    </div>
  );
}

function usePrefetchExport() {
  useEffect(() => {
    const prefetch = () => void loadExportPanel();
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(prefetch, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(prefetch, 1000);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Phone only (hidden by CSS above 640 px): the mode tiles pinned under the top bar. Export's
 * full-height sheet shows the preview above it instead, as on the board.
 */
function PhoneModeStrip() {
  const mode = useStore((s) => s.params.mode);
  const exporting = useStore((s) => s.exportUi.open);
  const setParam = useStore((s) => s.setParam);
  if (exporting) return null;
  // A labelled region, so the strip is inside a landmark like everything else on the page.
  return (
    <section className="phone-only" aria-label="Render mode">
      <ModeTiles className="mstrip" value={mode} onChange={(m) => setParam('mode', m)} />
    </section>
  );
}

// Full is 86%, as on the export board (spec §2 allows 86–88%), so the preview still shows above it.
const SHEET_DETENTS: readonly SheetDetentSpec<SheetDetent>[] = [
  { id: 'peek', label: 'Peek', height: () => 112 },
  { id: 'half', label: 'Half', height: (h) => h * 0.47 },
  { id: 'full', label: 'Full', height: (h) => h * 0.86 },
];
const SHEET_HEIGHT: Record<SheetDetent, string> = { peek: '112px', half: '47%', full: '86%' };

/**
 * The dock: Adjust (Inspector) or Export, swapped with a cross-fade. On phones it is the bottom
 * sheet; Export always opens it at full height and closing Export restores the previous detent.
 */
function Dock() {
  const exportOpen = useStore((s) => s.exportUi.open);
  const detent = useStore((s) => s.ui.sheetDetent);
  const setUi = useStore((s) => s.setUi);
  const ref = useRef<HTMLElement>(null);
  const beforeExport = useRef<SheetDetent>(detent);

  useEffect(() => {
    const ui = useStore.getState().ui;
    if (exportOpen) {
      beforeExport.current = ui.sheetDetent;
      setUi({ sheetDetent: 'full' });
    } else if (ui.sheetDetent === 'full') {
      setUi({ sheetDetent: beforeExport.current });
    }
  }, [exportOpen, setUi]);

  const style = { '--sheet-h': SHEET_HEIGHT[detent] } as CSSProperties;
  return (
    <aside ref={ref} className="dock" aria-label={exportOpen ? 'Export' : 'Adjust'} data-detent={detent} style={style}>
      <SheetGrab sheetRef={ref} detents={SHEET_DETENTS} detent={detent} onDetent={(d) => setUi({ sheetDetent: d })} />
      <div className="dock-panel" key={exportOpen ? 'export' : 'adjust'}>
        {exportOpen ? (
          <Suspense fallback={null}>
            <ExportPanel />
          </Suspense>
        ) : (
          <Inspector />
        )}
      </div>
    </aside>
  );
}

/** Polite announcements (mode changes, export start / finish / failure, decode errors). */
function LiveRegion() {
  const { id, text } = useStore((s) => s.ui.announcement);
  return (
    <div className="sr announcer" role="status" aria-live="polite">
      <span key={id}>{text}</span>
    </div>
  );
}
