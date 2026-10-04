/**
 * Holder for the non-serialisable singletons the UI shares: the engine, the loaded media and its
 * player. They stay out of the zustand store (they are mutable objects, not state).
 *
 * The shell's controller fills it (src/app/controller.ts); screens read it with `runtime.get()`
 * in event handlers / render loops, or `useRuntime(selector)` when React must re-render on change.
 */
import { useSyncExternalStore } from 'react';
import type { RendererEngine } from '../engine';
import type { LoadedMedia, Player } from '../media';

export interface RuntimeRefs {
  engine?: RendererEngine;
  media?: LoadedMedia;
  player?: Player;
}

type Listener = (refs: RuntimeRefs) => void;

let refs: RuntimeRefs = {};
const listeners = new Set<Listener>();

export const runtime = {
  get(): RuntimeRefs {
    return refs;
  },
  /** Shallow-merge; pass `undefined` to clear a slot. Notifies subscribers synchronously. */
  set(patch: Partial<RuntimeRefs>): void {
    refs = { ...refs, ...patch };
    for (const fn of listeners) fn(refs);
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useRuntime<T>(selector: (refs: RuntimeRefs) => T): T {
  return useSyncExternalStore(runtime.subscribe, () => selector(refs));
}
