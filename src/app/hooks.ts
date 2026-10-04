/**
 * App-level effects mounted once by App: theme attribute, document title, global shortcuts,
 * window-wide file drop and paste, settings links pasted into the address bar. They talk to the
 * store and the controller; screens only read `ui.dragOver`.
 */
import { useEffect } from 'react';
import type { Theme } from '../state/params';
import { useStore } from '../state/store';
import { openFile } from './controller';
import { registerDefaultShortcuts } from './defaultShortcuts';
import { classifyDrag } from './filePicker';
import { listenForSettingsLinks } from './permalink';
import { installShortcutListener } from './shortcuts';
import { toast } from '../ui/kit';
import { openUrl, parseHttpUrl } from '../ui/start/openers';

/** Variant B is one attribute on <html>; variant A is the :root default. The browser chrome follows --g1. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'b') root.dataset.theme = 'b';
  else delete root.dataset.theme;
  const chrome = getComputedStyle(root).getPropertyValue('--g1').trim();
  if (chrome) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chrome);
}

export function useThemeSync(): void {
  useEffect(() => {
    applyTheme(useStore.getState().ui.theme);
    return useStore.subscribe((s) => s.ui.theme, applyTheme);
  }, []);
}

const APP_TITLE = 'ASCII Renderer';

/** The tab names the open file ("torus.png · ASCII Renderer"), so several tabs stay tellable apart. */
export function useDocumentTitle(): void {
  useEffect(() => {
    const apply = (name: string | undefined) => {
      document.title = name ? `${name} · ${APP_TITLE}` : APP_TITLE;
    };
    apply(useStore.getState().media.info?.name);
    return useStore.subscribe((s) => s.media.info?.name, apply);
  }, []);
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    registerDefaultShortcuts();
    return installShortcutListener();
  }, []);
}

/**
 * The whole window is a drop target (spec §4.1). Unsupported types are refused on dragenter:
 * dropEffect 'none' (not-allowed cursor) and `dragOver.supported: false` (no accent). A drop
 * that turns out unsupported is reported by the controller.
 */
export function useWindowFileDrop(): void {
  useEffect(() => {
    let depth = 0;
    const setDrag = useStore.getState().setUi;
    const leaveAll = () => {
      depth = 0;
      setDrag({ dragOver: null });
    };

    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const info = classifyDrag(e.dataTransfer);
      if (!info.files) return;
      depth += 1;
      if (depth === 1) setDrag({ dragOver: { supported: info.supported, kind: info.kind } });
    };
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      // Always handled, so the browser never navigates to a dropped file; 'none' refuses it.
      e.preventDefault();
      e.dataTransfer.dropEffect = useStore.getState().ui.dragOver?.supported ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files') || depth === 0) return;
      depth -= 1;
      if (depth === 0) setDrag({ dragOver: null });
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      const file = files?.[0];
      leaveAll();
      if (!file) return;
      e.preventDefault();
      void openFile(file);
      // One file is shown at a time; say so instead of silently dropping the rest.
      const rest = files.length - 1;
      if (rest > 0) toast({ kind: 'info', title: `Opened ${file.name}`, body: `One file at a time: ${rest === 1 ? 'the other file was' : `the other ${rest} were`} not opened.` });
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

/** ⌘V anywhere outside a text field opens a pasted image or video file, or a copied link to one. */
export function usePasteToOpen(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
      // Any pasted file is tried: the format is sniffed from its bytes, and an unsupported one is reported.
      const file = e.clipboardData?.files[0];
      if (file) {
        e.preventDefault();
        void openFile(file);
        return;
      }
      const text = e.clipboardData?.getData('text/plain').trim() ?? '';
      if (!parseHttpUrl(text)) return;
      e.preventDefault();
      void openUrl(text, new AbortController().signal);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
}

/** A settings link pasted into the address bar of this tab applies at once (the initial one is applied in main.tsx). */
export function useSettingsLinks(): void {
  useEffect(() => listenForSettingsLinks(), []);
}
