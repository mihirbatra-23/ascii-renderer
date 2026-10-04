/**
 * Toasts (spec §5): 380 px cards at the bottom centre of the stage, newest at the bottom,
 * at most three. Success / info dismiss after 5 s (paused while hovered or focused); errors stay
 * until dismissed.
 *
 * Each toast is announced once: ToastHost keeps two visually hidden live regions mounted (polite
 * for success / info, assertive for errors) that hold the newest toast's text, while the visible
 * cards carry no live semantics (nesting them in a live region read every toast two or three
 * times). Callers do not also announce what they toast.
 *
 * Timers run here, not in the cards: a toast keeps its own clock when the host remounts (start
 * screen → editor), so it never restarts its 5 s on the next file.
 *
 *   toast({ kind: 'error', title: 'Couldn’t decode clip.mov', body: '…', actions: [{ label: 'Try again', onClick }] })
 *   toast({ kind: 'success', title: 'Saved torus_ascii@2x.png', body: '2560 × 1440 px · 1.4 MB', trailing: { label: 'Undo', onClick } })
 *   <ToastHost />                       inside the stage (positioned against .stage-main)
 *   <ToastHost placement="window" />    the start screen
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { Button, IconButton } from './Button';
import { cx } from './util';

export type ToastKind = 'error' | 'success' | 'info';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  kind?: ToastKind;
  title: string;
  body?: ReactNode;
  /** Defaults: error → alert, success → check, info → info. */
  icon?: IconName;
  /** Small buttons under the body (first one secondary, the rest ghost). */
  actions?: readonly ToastAction[];
  /** A ghost button on the right instead of the dismiss × (e.g. Undo). */
  trailing?: ToastAction;
  /** Auto-dismiss delay; errors default to never (0). */
  durationMs?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
  kind: ToastKind;
}

interface ToastState {
  list: readonly ToastEntry[];
  /** The newest success / info and error toast: what the host's live regions say. */
  polite: ToastEntry | null;
  alert: ToastEntry | null;
}

/** A toast's auto-dismiss clock: time left, and since when it has been running (null while paused). */
interface Clock {
  remainingMs: number;
  runningSince: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_VISIBLE = 3;
const DEFAULT_MS = 5000;
const DEFAULT_ICON: Record<ToastKind, IconName> = { error: 'alert', success: 'check', info: 'info' };

let state: ToastState = { list: [], polite: null, alert: null };
let nextId = 1;
/** The newest toast a host's live region has said; a remounted host never repeats it. */
let spoken = 0;
const clocks = new Map<number, Clock>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function run(id: number, clock: Clock): void {
  clock.runningSince = performance.now();
  clock.timer = setTimeout(() => dismissToast(id), clock.remainingMs);
}

/** Show a toast; returns its id for dismissToast. */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  const entry: ToastEntry = { ...options, kind: options.kind ?? 'info', id };
  const list = [...state.list, entry];
  for (const dropped of list.slice(0, -MAX_VISIBLE)) stopClock(dropped.id);
  state = {
    list: list.slice(-MAX_VISIBLE),
    polite: entry.kind === 'error' ? state.polite : entry,
    alert: entry.kind === 'error' ? entry : state.alert,
  };
  const duration = options.durationMs ?? (entry.kind === 'error' ? 0 : DEFAULT_MS);
  if (duration > 0) {
    const clock: Clock = { remainingMs: duration, runningSince: null };
    clocks.set(id, clock);
    run(id, clock);
  }
  emit();
  return id;
}

export function dismissToast(id: number): void {
  stopClock(id);
  state = { ...state, list: state.list.filter((t) => t.id !== id) };
  emit();
}

function stopClock(id: number): void {
  clearTimeout(clocks.get(id)?.timer);
  clocks.delete(id);
}

/** Holds or releases a toast's auto-dismiss (while it is hovered or has focus). */
function holdToast(id: number, held: boolean): void {
  const clock = clocks.get(id);
  if (!clock) return;
  if (held && clock.runningSince !== null) {
    clearTimeout(clock.timer);
    clock.remainingMs -= performance.now() - clock.runningSince;
    clock.runningSince = null;
  } else if (!held && clock.runningSince === null) {
    run(id, clock);
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useToast() {
  return { toast, dismiss: dismissToast };
}

export function ToastHost({ placement = 'stage' }: { placement?: 'stage' | 'window' }) {
  const { list, polite: newestPolite, alert: newestAlert } = useSyncExternalStore(subscribe, () => state);
  // The live regions mount empty and are filled after mount: a region must exist before content
  // arrives for screen readers to announce it (a toast raised before the host mounted, such as a
  // settings link's on page load, is said then). What an earlier host already said is not repeated.
  const [mounted, setMounted] = useState(false);
  const since = useRef(spoken);
  useEffect(() => setMounted(true), []);
  const unsaid = (t: ToastEntry | null) => (mounted && t && t.id > since.current ? t : null);
  const polite = unsaid(newestPolite);
  const alert = unsaid(newestAlert);
  useEffect(() => {
    spoken = Math.max(spoken, polite?.id ?? 0, alert?.id ?? 0);
  }, [polite, alert]);
  // Keyed by toast id, so a repeated message is announced again.
  return (
    <>
      <div className={cx('toasts', placement === 'window' && 'window')}>
        {list.map((t) => (
          <ToastCard key={t.id} entry={t} />
        ))}
      </div>
      <div className="sr toast-live" role="status">
        {polite && <ToastText key={polite.id} entry={polite} />}
      </div>
      <div className="sr toast-live" role="alert">
        {alert && <ToastText key={alert.id} entry={alert} />}
      </div>
    </>
  );
}

function ToastText({ entry }: { entry: ToastEntry }) {
  return (
    <span>
      {entry.title}
      {entry.body ? <>. {entry.body}</> : null}
    </span>
  );
}

function ToastCard({ entry }: { entry: ToastEntry }) {
  const { id, ...options } = entry;
  const hovered = useRef(false);
  const focused = useRef(false);
  const update = () => holdToast(id, hovered.current || focused.current);
  // A card unmounted while held (the host went away under the pointer) lets its clock run again.
  useEffect(() => () => holdToast(id, false), [id]);

  return (
    <ToastView
      {...options}
      onDismiss={() => dismissToast(id)}
      onPointerEnter={() => {
        hovered.current = true;
        update();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        update();
      }}
      onFocus={() => {
        focused.current = true;
        update();
      }}
      onBlur={(e) => {
        // Focus moving between the toast's own buttons keeps it held.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focused.current = false;
        update();
      }}
    />
  );
}

export interface ToastViewProps extends ToastOptions, Omit<ComponentProps<'div'>, 'title'> {
  onDismiss?(): void;
}

/** The toast card itself, without queueing or timers (ToastHost uses it; so does the kit page). */
export function ToastView({ kind = 'info', title, body, icon, actions, trailing, durationMs: _ms, onDismiss, className, ...rest }: ToastViewProps) {
  const run = (a: ToastAction) => () => {
    onDismiss?.();
    a.onClick();
  };
  return (
    <div className={cx('toast', kind === 'error' && 'err', className)} {...rest}>
      <Icon name={icon ?? DEFAULT_ICON[kind]} />
      <div className="tx">
        <b>{title}</b>
        {body && <p>{body}</p>}
        {actions?.length ? (
          <div className="acts">
            {actions.map((a, i) => (
              <Button key={a.label} size="sm" variant={i === 0 ? 'secondary' : 'ghost'} onClick={run(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {trailing ? (
        <Button size="sm" variant="ghost" onClick={run(trailing)}>
          {trailing.label}
        </Button>
      ) : (
        kind === 'error' && onDismiss && <IconButton icon="x" label="Dismiss" size="sm" tooltip={false} onClick={onDismiss} />
      )}
    </div>
  );
}
