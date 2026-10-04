/**
 * The app's keyboard map (design spec §10). Store-level actions get their handlers here;
 * playback goes through runtime.player. Screens may replace any handler with
 * updateShortcut(id, { handler }) or add their own actions (e.g. the start screen's 1–3 samples,
 * the export panel's 'export.download').
 */
import { clampParam, COLOR_MODES, RENDER_MODES } from '../state/params';
import { selectHasMedia, selectIsAnimated, selectIsLive, useStore } from '../state/store';
import { MODE_LABELS } from '../ui/kit/Tile';
import { actualSize, fitView } from '../ui/stage/viewActions';
import { pickAndOpen } from '../ui/start/openers';
import { runtime } from './runtime';
import { registerShortcut, type ShortcutAction } from './shortcuts';

const state = () => useStore.getState();
const hasMedia = () => selectHasMedia(state());
const isAnimated = () => hasMedia() && selectIsAnimated(state());
/** A clip with a timeline: a live camera only plays and pauses. */
const isClip = () => isAnimated() && !selectIsLive(state());

function cycle<T>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length];
}

/** A held [ or ] repeats; the count is announced once the keys settle, not on every step. */
const COLUMNS_ANNOUNCE_MS = 400;
let columnsTimer: ReturnType<typeof setTimeout> | undefined;

function stepColumns(e: KeyboardEvent, dir: 1 | -1) {
  const s = state();
  // Held keys repeat: 'idle' folds the burst into one undo entry.
  s.setParam('columns', clampParam('columns', s.params.columns + dir * (e.shiftKey ? 10 : 1)), { commit: 'idle' });
  clearTimeout(columnsTimer);
  columnsTimer = setTimeout(() => state().announce(`Columns ${state().params.columns}`), COLUMNS_ANNOUNCE_MS);
}

/** Toggles say their new state, so keyboard and screen-reader users hear what a key did. */
function toggleInvert() {
  const invert = !state().params.invert;
  state().setParam('invert', invert);
  state().announce(`Invert ${invert ? 'on' : 'off'}`);
}

function toggleRulers() {
  const rulers = !state().view.rulers;
  state().setView({ rulers });
  state().announce(`Rulers ${rulers ? 'on' : 'off'}`);
}

function toggleSplit() {
  const mode = state().view.mode === 'split' ? 'output' : 'split';
  state().setView({ mode });
  state().announce(mode === 'split' ? 'Split view' : 'Output view');
}

function stepFrames(e: KeyboardEvent, dir: 1 | -1) {
  const player = runtime.get().player;
  if (!player) return;
  player.pause();
  void player.step(dir * (e.shiftKey ? 10 : 1));
}

const COLOR_LABELS = { mono: 'Mono', source: 'Source', duotone: 'Duotone' } as const;

const DEFAULTS: ShortcutAction[] = [
  // File
  {
    id: 'file.open',
    label: 'Open a file',
    group: 'File',
    keys: ['mod+o'],
    inInputs: true,
    handler: pickAndOpen,
  },
  { id: 'file.paste', label: 'Paste a file or link', group: 'File', keys: ['mod+v'], displayOnly: true },
  {
    id: 'export.toggle',
    label: 'Open or close Export',
    group: 'File',
    keys: ['mod+e'],
    inInputs: true,
    enabled: hasMedia,
    handler: () => state().setExportUi({ open: !state().exportUi.open }),
  },
  { id: 'export.download', label: 'Download or record', group: 'File', keys: ['mod+enter'], inInputs: true },

  // Edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['mod+z'], repeat: true, handler: () => state().undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['shift+mod+z', 'mod+y'], repeat: true, handler: () => state().redo() },

  // Render
  {
    id: 'render.mode',
    label: 'Next mode',
    group: 'Render',
    keys: ['m'],
    enabled: hasMedia,
    handler: () => {
      const mode = cycle(RENDER_MODES, state().params.mode);
      state().setParam('mode', mode);
      state().announce(`Mode: ${MODE_LABELS[mode]}`);
    },
  },
  {
    id: 'render.invert',
    label: 'Invert',
    group: 'Render',
    keys: ['i'],
    enabled: hasMedia,
    handler: toggleInvert,
  },
  {
    id: 'render.color',
    label: 'Next color mode',
    group: 'Render',
    keys: ['d'],
    enabled: hasMedia,
    handler: () => {
      const mode = cycle(COLOR_MODES, state().params.colorMode);
      state().setParam('colorMode', mode);
      state().announce(`Color: ${COLOR_LABELS[mode]}`);
    },
  },
  { id: 'grid.less', label: 'Fewer columns (Shift: 10)', group: 'Render', keys: ['[', 'shift+['], repeat: true, enabled: hasMedia, handler: (e) => stepColumns(e, -1) },
  { id: 'grid.more', label: 'More columns (Shift: 10)', group: 'Render', keys: [']', 'shift+]'], repeat: true, enabled: hasMedia, handler: (e) => stepColumns(e, 1) },

  // View
  {
    id: 'view.compare',
    label: 'Toggle Split view',
    group: 'View',
    keys: ['\\', 's'],
    enabled: hasMedia,
    handler: toggleSplit,
  },
  { id: 'view.rulers', label: 'Toggle rulers', group: 'View', keys: ['r'], enabled: hasMedia, handler: toggleRulers },
  { id: 'view.fit', label: 'Zoom to fit', group: 'View', keys: ['0', 'f'], enabled: hasMedia, handler: fitView },
  { id: 'view.actual', label: 'Zoom to 100%', group: 'View', keys: ['1'], enabled: hasMedia, handler: actualSize },

  // Playback (GIF and video)
  {
    id: 'playback.toggle',
    label: 'Play / pause',
    group: 'Playback',
    keys: ['space'],
    enabled: isAnimated,
    handler: () => {
      const player = runtime.get().player;
      if (player?.playing) player.pause();
      else player?.play();
    },
  },
  { id: 'playback.prev', label: 'Previous frame (Shift: 10)', group: 'Playback', keys: [',', 'arrowleft', 'shift+arrowleft'], repeat: true, enabled: isClip, handler: (e) => stepFrames(e, -1) },
  { id: 'playback.next', label: 'Next frame (Shift: 10)', group: 'Playback', keys: ['.', 'arrowright', 'shift+arrowright'], repeat: true, enabled: isClip, handler: (e) => stepFrames(e, 1) },
  {
    id: 'playback.loop',
    label: 'Toggle loop',
    group: 'Playback',
    keys: ['l'],
    enabled: isClip,
    handler: () => {
      const loop = !state().playback.loop;
      const player = runtime.get().player;
      if (player) player.loop = loop;
      state().setPlayback({ loop });
    },
  },
  {
    id: 'playback.in',
    label: 'Set In at the playhead',
    group: 'Playback',
    keys: ['shift+i'],
    enabled: isClip,
    handler: () => {
      const player = runtime.get().player;
      if (!player) return;
      player.inPoint = Math.min(player.currentTime, player.outPoint);
      state().setPlayback({ inPoint: player.inPoint });
    },
  },
  {
    id: 'playback.out',
    label: 'Set Out at the playhead',
    group: 'Playback',
    keys: ['shift+o'],
    enabled: isClip,
    handler: () => {
      const player = runtime.get().player;
      if (!player) return;
      player.outPoint = Math.max(player.currentTime, player.inPoint);
      state().setPlayback({ outPoint: player.outPoint });
    },
  },
  { id: 'playback.slow', label: 'Half speed', group: 'Playback', keys: ['j'], enabled: isClip, handler: () => state().setPlayback({ rate: 0.5 }) },
  { id: 'playback.normal', label: 'Normal speed', group: 'Playback', keys: ['k'], enabled: isClip, handler: () => state().setPlayback({ rate: 1 }) },

  // General
  {
    id: 'help.shortcuts',
    label: 'Keyboard shortcuts',
    group: 'General',
    keys: ['?'],
    handler: () => state().setUi({ shortcutsOpen: !state().ui.shortcutsOpen }),
  },
  {
    id: 'panel.close',
    label: 'Close Export or this sheet',
    group: 'General',
    keys: ['escape'],
    inInputs: true,
    enabled: () => state().ui.shortcutsOpen || state().exportUi.open,
    handler: () => {
      if (state().ui.shortcutsOpen) state().setUi({ shortcutsOpen: false });
      else state().setExportUi({ open: false });
    },
  },
];

let registered = false;

/** Idempotent: registers the default actions once per page. */
export function registerDefaultShortcuts(): void {
  if (registered) return;
  registered = true;
  for (const action of DEFAULTS) registerShortcut(action);
}
