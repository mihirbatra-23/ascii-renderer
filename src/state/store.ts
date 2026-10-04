/**
 * The app store (zustand + subscribeWithSelector). Serialisable state only; engine, media and
 * player singletons live in src/app/runtime.ts.
 *
 * Components must subscribe with narrow selectors (`useStore((s) => s.params.columns)`), and use
 * `useShallow` for object picks, so a slider drag re-renders only what shows that value.
 *
 * Param history: every setParam records the params as they were before the gesture began.
 * `commit: false` keeps the gesture open (continuous drags), `commit: true` (default) closes it
 * into one undo entry, `'idle'` closes it after a short pause (key repeat, wheel).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { RenderParams } from '../engine/types';
import type { ExportFormat, ExportResult } from '../export/types';
import type { MediaKind } from '../media/types';
import {
  BUILTIN_PRESETS,
  PARAM_LABELS,
  PARAM_SECTIONS,
  defaultParams,
  paramsEqual,
  sanitizeParams,
  themeColors,
  type ParamKey,
  type ParamSection,
  type Theme,
} from './params';
import { readPersisted, writePersisted } from './persist';

// ---------------------------------------------------------------- state slices

export type MediaStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface MediaInfo {
  name: string;
  kind: MediaKind;
  width: number;
  height: number;
  fileSize: number;
  formatLabel: string;
  durationSec?: number;
  fps?: number;
  frameCount?: number;
  /** A live camera stream: no duration, trim or seeking. */
  live?: boolean;
}

export interface MediaState {
  status: MediaStatus;
  info?: MediaInfo;
  error?: string;
  /** While loading: what is being opened (a file name, or 'Camera'), for the start screen's progress line. */
  pending?: string;
}

export type ViewMode = 'output' | 'split' | 'source';
/** What the left of the Split shows: the untouched source, or a plain Ramp render of it (Viewport.compareWith). */
export type CompareWith = 'source' | 'ramp';

export interface Probe {
  col: number;
  row: number;
  char: string;
  /** Tone-mapped lightness 0..1 of the probed cell. */
  L: number;
}

export interface ViewState {
  mode: ViewMode;
  /** Split position 0..1 from the left. */
  split: number;
  compareWith: CompareWith;
  /** 'fit' or CSS px per output px (1 = actual size). */
  zoom: 'fit' | number;
  panX: number;
  panY: number;
  rulers: boolean;
  probe: Probe | null;
}

export interface PlaybackState {
  playing: boolean;
  /** Seconds. */
  time: number;
  duration: number;
  frame: number;
  frameCount: number;
  inPoint: number;
  outPoint: number;
  loop: boolean;
  rate: number;
}

export interface StatsState {
  cols: number;
  rows: number;
  /** Render time per frame, ms: a rolling average of recent frames. */
  ms: number;
  /** What `ms` measures: GPU time (timer queries) when the browser has them, else CPU submit time. */
  timer: 'gpu' | 'cpu';
  /** Frames drawn per second while frames flow; 0 at rest. */
  fps: number;
  gpu: 'WebGL2' | 'CPU';
}

export type ExportScale = 1 | 2 | 4 | 'custom';

export interface ExportUiState {
  open: boolean;
  format: ExportFormat;
  /** PNG scale. */
  scale: ExportScale;
  /** GIF / MP4 / WebM scale: kept apart so a 2× still default never makes a 100 MB GIF. */
  motionScale: ExportScale;
  /** Custom output width in px (scale === 'custom'). */
  customWidth?: number;
  margin: number;
  transparent: boolean;
  pixelSnap: boolean;
  svgText: 'outlines' | 'text';
  fps: number | 'source';
  includeAudio: boolean;
  trimOnly: boolean;
  /** Base name without extension; '' means derive it from the media name. */
  fileName: string;
}

/** A live camera being recorded in real time (the status bar's readout). */
export interface RecordingState {
  container: 'mp4' | 'webm';
  elapsedSec: number;
  frames: number;
}

export interface JobState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** 0..1, or null while indeterminate. */
  progress: number | null;
  label: string;
  etaSec: number | null;
  error: string | null;
  result: ExportResult | null;
  /** Set while a camera recording runs (kept in the store so the status bar needs no export code). */
  recording: RecordingState | null;
}

export type SheetTab = 'adjust' | 'glyphs' | 'color';
export type SheetDetent = 'peek' | 'half' | 'full';

export interface DragInfo {
  /** False when the dragged item is clearly not something we can open (no accent, not-allowed cursor). */
  supported: boolean;
  kind?: MediaKind;
  /** Only known on some platforms during the drag. */
  name?: string;
}

export interface UiState {
  theme: Theme;
  sheetTab: SheetTab;
  sheetDetent: SheetDetent;
  shortcutsOpen: boolean;
  dragOver: DragInfo | null;
  /** Latest polite announcement; `id` changes so repeating the same text is re-announced. */
  announcement: { id: number; text: string };
}

export interface UserPreset {
  name: string;
  params: RenderParams;
}

export interface CommitOptions {
  commit?: boolean | 'idle';
}

export interface AppState {
  params: RenderParams;
  history: { past: RenderParams[]; future: RenderParams[] };
  userPresets: UserPreset[];
  media: MediaState;
  view: ViewState;
  playback: PlaybackState;
  stats: StatsState;
  exportUi: ExportUiState;
  job: JobState;
  ui: UiState;

  setParam<K extends ParamKey>(key: K, value: RenderParams[K], options?: CommitOptions): void;
  setParams(patch: Partial<RenderParams>, options?: CommitOptions): void;
  /** Close the open gesture into one undo entry (pointerup, change, blur). */
  commitParams(): void;
  undo(): void;
  redo(): void;
  resetParams(section?: ParamSection): void;
  /** Built-in or user preset by name. */
  applyPreset(name: string): void;
  savePreset(name: string): void;
  deletePreset(name: string): void;

  setMedia(patch: Partial<MediaState>): void;
  setView(patch: Partial<ViewState>): void;
  setPlayback(patch: Partial<PlaybackState>): void;
  setStats(patch: Partial<StatsState>): void;
  setExportUi(patch: Partial<ExportUiState>): void;
  setJob(patch: Partial<JobState>): void;
  setUi(patch: Partial<UiState>): void;
  setTheme(theme: Theme): void;
  /** Polite screen-reader announcement (mode changes, export start/finish, errors). */
  announce(text: string): void;
}

// ---------------------------------------------------------------- defaults

const MAX_HISTORY = 100;
const IDLE_COMMIT_MS = 400;

export const INITIAL_VIEW: ViewState = { mode: 'output', split: 0.5, compareWith: 'source', zoom: 'fit', panX: 0, panY: 0, rulers: true, probe: null };

export const INITIAL_PLAYBACK: PlaybackState = {
  playing: false,
  time: 0,
  duration: 0,
  frame: 0,
  frameCount: 0,
  inPoint: 0,
  outPoint: 0,
  loop: true,
  rate: 1,
};

export const INITIAL_EXPORT_UI: ExportUiState = {
  open: false,
  format: 'png',
  scale: 2,
  motionScale: 1,
  margin: 0,
  transparent: false,
  pixelSnap: true,
  svgText: 'outlines',
  fps: 'source',
  includeAudio: true,
  trimOnly: true,
  fileName: '',
};

export const IDLE_JOB: JobState = { status: 'idle', progress: null, label: '', etaSec: null, error: null, result: null, recording: null };

// ---------------------------------------------------------------- persistence (load)

/** Upper bounds for restored values; anything outside them comes from another build or a hand edit. */
const MAX_EXPORT_MARGIN = 256;
const MAX_PRESET_NAME = 60;
const MAX_USER_PRESETS = 100;
const SCALES: readonly ExportScale[] = [1, 2, 4];

const saved = readPersisted();
const initialTheme: Theme = saved.theme === 'b' ? 'b' : 'a';

/**
 * User presets from storage: named, deduplicated by name (the later one wins, as savePreset does)
 * and capped, each with sanitised params.
 */
export function loadUserPresets(input: unknown, theme: Theme): UserPreset[] {
  if (!Array.isArray(input)) return [];
  const byName = new Map<string, UserPreset>();
  for (const p of input) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const name = p.name.trim().slice(0, MAX_PRESET_NAME);
    if (!name) continue;
    byName.delete(name);
    byName.set(name, { name, params: sanitizeParams(p.params, defaultParams(theme)) });
  }
  return [...byName.values()].slice(-MAX_USER_PRESETS);
}

/**
 * The persisted export settings, each checked against what the panel can set: a scale the panel
 * offers (custom widths are not persisted), an integer margin in range, a known SVG text mode and
 * strict booleans. A bad value falls back to the default, so the size the panel promises is the
 * size the file gets.
 */
export function loadExportUi(input: unknown): ExportUiState {
  const out = { ...INITIAL_EXPORT_UI };
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  const scale = (v: unknown): ExportScale | undefined => SCALES.find((s) => s === v);
  out.scale = scale(src.scale) ?? out.scale;
  out.motionScale = scale(src.motionScale) ?? out.motionScale;
  if (Number.isInteger(src.margin) && (src.margin as number) >= 0 && (src.margin as number) <= MAX_EXPORT_MARGIN) out.margin = src.margin as number;
  if (src.svgText === 'outlines' || src.svgText === 'text') out.svgText = src.svgText;
  for (const key of ['transparent', 'pixelSnap', 'includeAudio'] as const) if (typeof src[key] === 'boolean') out[key] = src[key];
  return out;
}

/** "Contrast", "Contrast and Gamma", "Contrast, Gamma and 3 more": what an undo or redo changed. */
export function describeParamChange(from: RenderParams, to: RenderParams): string {
  const changed = (Object.keys(PARAM_LABELS) as ParamKey[]).filter((k) => from[k] !== to[k]).map((k) => PARAM_LABELS[k]);
  if (changed.length <= 2) return changed.join(' and ');
  return `${changed.slice(0, 2).join(', ')} and ${changed.length - 2} more`;
}

// ---------------------------------------------------------------- store

/** Params as they were before the open (uncommitted) gesture, or null when none is open. */
let gestureBase: RenderParams | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let announceId = 0;

export const useStore = create<AppState>()(
  subscribeWithSelector((set, get) => {
    function closeGesture(): void {
      clearTimeout(idleTimer);
      const base = gestureBase;
      gestureBase = null;
      if (!base || paramsEqual(base, get().params)) return;
      const past = [...get().history.past, base].slice(-MAX_HISTORY);
      set({ history: { past, future: [] } });
    }

    function changeParams(patch: Partial<RenderParams>, options: CommitOptions = {}): void {
      const commit = options.commit ?? true;
      gestureBase ??= get().params;
      set({ params: { ...get().params, ...patch } });
      clearTimeout(idleTimer);
      if (commit === true) closeGesture();
      else if (commit === 'idle') idleTimer = setTimeout(closeGesture, IDLE_COMMIT_MS);
    }

    return {
      params: sanitizeParams(saved.params, defaultParams(initialTheme)),
      history: { past: [], future: [] },
      userPresets: loadUserPresets(saved.userPresets, initialTheme),
      media: { status: 'empty' },
      view: { ...INITIAL_VIEW, rulers: saved.rulers !== false },
      playback: INITIAL_PLAYBACK,
      stats: { cols: 0, rows: 0, ms: 0, timer: 'cpu', fps: 0, gpu: 'WebGL2' },
      exportUi: loadExportUi(saved.exportUi),
      job: IDLE_JOB,
      ui: {
        theme: initialTheme,
        sheetTab: 'adjust',
        sheetDetent: 'half',
        shortcutsOpen: false,
        dragOver: null,
        announcement: { id: 0, text: '' },
      },

      setParam: (key, value, options) => changeParams({ [key]: value } as Partial<RenderParams>, options),
      setParams: changeParams,
      commitParams: closeGesture,

      undo() {
        closeGesture();
        const { past, future } = get().history;
        const prev = past.at(-1);
        if (!prev) return;
        const current = get().params;
        set({ params: prev, history: { past: past.slice(0, -1), future: [current, ...future] } });
        get().announce(`Undone: ${describeParamChange(current, prev)}`);
      },

      redo() {
        closeGesture();
        const { past, future } = get().history;
        const next = future[0];
        if (!next) return;
        const current = get().params;
        set({ params: next, history: { past: [...past, current], future: future.slice(1) } });
        get().announce(`Redone: ${describeParamChange(current, next)}`);
      },

      resetParams(section) {
        const defaults = defaultParams(get().ui.theme);
        if (!section) return changeParams(defaults);
        const patch: Partial<RenderParams> = {};
        for (const key of PARAM_SECTIONS[section]) Object.assign(patch, { [key]: defaults[key] });
        changeParams(patch);
      },

      applyPreset(name) {
        const builtin = BUILTIN_PRESETS.find((p) => p.name === name);
        const user = get().userPresets.find((p) => p.name === name);
        const patch = builtin?.params ?? user?.params;
        if (!patch) return;
        // The caller confirms it (presetActions' "Applied …" toast, which is also what is announced).
        changeParams(patch);
      },

      savePreset(name) {
        const trimmed = name.trim();
        if (!trimmed) return;
        const others = get().userPresets.filter((p) => p.name !== trimmed);
        set({ userPresets: [...others, { name: trimmed, params: { ...get().params } }] });
      },

      deletePreset(name) {
        set({ userPresets: get().userPresets.filter((p) => p.name !== name) });
      },

      setMedia: (patch) => set({ media: { ...get().media, ...patch } }),
      setView: (patch) => set({ view: { ...get().view, ...patch } }),
      setPlayback: (patch) => set({ playback: { ...get().playback, ...patch } }),
      setStats: (patch) => set({ stats: { ...get().stats, ...patch } }),
      setExportUi: (patch) => set({ exportUi: { ...get().exportUi, ...patch } }),
      setJob: (patch) => set({ job: { ...get().job, ...patch } }),
      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),

      setTheme(theme) {
        const { ui, params } = get();
        if (ui.theme === theme) return;
        // Untouched render colours follow the theme's ink and paper; customised ones are kept.
        const prev = themeColors(ui.theme);
        const untouched = params.ink === prev.ink && params.shadowInk === prev.shadowInk && params.paper === prev.paper;
        set({ ui: { ...ui, theme }, ...(untouched ? { params: { ...params, ...themeColors(theme) } } : {}) });
      },

      announce(text) {
        set({ ui: { ...get().ui, announcement: { id: ++announceId, text } } });
      },
    };
  }),
);

// ---------------------------------------------------------------- persistence (save)

useStore.subscribe(
  (s) => [s.params, s.ui.theme, s.exportUi, s.view.rulers, s.userPresets] as const,
  ([params, theme, exportUi, rulers, userPresets]) => {
    const { scale, motionScale, margin, transparent, pixelSnap, svgText, includeAudio } = exportUi;
    writePersisted({ params, theme, rulers, userPresets, exportUi: { scale, motionScale, margin, transparent, pixelSnap, svgText, includeAudio } });
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);

// ---------------------------------------------------------------- selectors

export const selectCanUndo = (s: AppState) => s.history.past.length > 0;
export const selectCanRedo = (s: AppState) => s.history.future.length > 0;
export const selectIsAnimated = (s: AppState) => !!s.media.info && s.media.info.kind !== 'image';
/** A live camera: plays and pauses, but has no timeline, trim or frame-accurate export. */
export const selectIsLive = (s: AppState) => s.media.info?.live === true;
/** Something is on screen (also while the next file loads, or after one failed to open). */
export const selectHasMedia = (s: AppState) => !!s.media.info && s.media.status !== 'empty';
