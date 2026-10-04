/**
 * Settings links: the current look as a URL that opens with the same parameters.
 *
 *   #s=<base64url JSON>      JSON = { v: 1, p: { …params that differ from the defaults } }
 *
 *   encodeSettings(params)           → the hash payload (no '#s=')
 *   decodeSettings(payload)          → full, sanitised params, or null when the payload is unusable
 *   settingsLink(params)             → the shareable URL for the current page
 *   copySettingsLink()               copies it; shows its own toast and announcement, never rejects
 *   applySettingsFromUrl()           on load and on hashchange: a link wins over the stored params;
 *                                    the hash is removed afterwards so a reload keeps later edits
 *   linkLookUnedited()               whether the params are still exactly a link's look (samples
 *                                    then open in it instead of their own)
 *
 * Only parameters travel (no media, no view state): nothing about the user's files ever ends up in
 * a URL. Values are sanitised exactly like stored ones, so a hand-edited link cannot push anything
 * out of range into the engine.
 */
import type { RenderParams } from '../engine/types';
import { defaultParams, paramsEqual, sanitizeParams, type ParamKey } from '../state/params';
import { useStore } from '../state/store';
import { toast } from '../ui/kit';
import { formatCombo, shortcutLabel } from './shortcuts';

const PREFIX = '#s=';
const VERSION = 1;

/** The params as the last settings link left them (this session only). */
let linkLook: RenderParams | null = null;

/** True while the settings are a link's look, unedited: what a recipient came to see. */
export function linkLookUnedited(): boolean {
  return linkLook !== null && paramsEqual(useStore.getState().params, linkLook);
}

interface Payload {
  v: number;
  /** Parameter values that differ from the defaults (validated on the way in, never trusted). */
  p: Partial<Record<ParamKey, unknown>>;
}

/** Only what differs from the defaults, so links stay short and follow future default changes. */
export function encodeSettings(params: RenderParams): string {
  const defaults = defaultParams();
  const p: Partial<Record<ParamKey, unknown>> = {};
  for (const key of Object.keys(defaults) as ParamKey[]) if (params[key] !== defaults[key]) p[key] = params[key];
  return toBase64Url(JSON.stringify({ v: VERSION, p } satisfies Payload));
}

/**
 * Full params for a payload: the defaults with the link's values on top (links made with the removed
 * Carbon theme carry its ink and paper only if they differed from that theme's defaults).
 * Null for anything that is not a version-1 settings object.
 */
export function decodeSettings(payload: string): RenderParams | null {
  let data: unknown;
  try {
    data = JSON.parse(fromBase64Url(payload));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { v, p } = data as { v?: unknown; p?: unknown };
  if (v !== VERSION || !p || typeof p !== 'object') return null;
  return sanitizeParams(p, defaultParams());
}

export function settingsLink(params: RenderParams): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}${PREFIX}${encodeSettings(params)}`;
}

export async function copySettingsLink(): Promise<void> {
  const { params } = useStore.getState();
  const link = settingsLink(params);
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    toast({ kind: 'error', icon: 'link', title: 'Couldn’t copy the link', body: 'This browser blocked clipboard access. Allow it for this site, then try again.' });
    return;
  }
  toast({ kind: 'success', icon: 'link', title: 'Settings link copied', body: 'The link holds your settings, not your file.' });
}

/**
 * Applies a settings link in the address bar, if there is one, as one undoable change, then removes
 * the hash. Returns whether a link was applied. Malformed or newer-version links are reported, not
 * half-applied.
 */
export function applySettingsFromUrl(): boolean {
  const { hash } = window.location;
  if (!hash.startsWith(PREFIX)) return false;
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  const store = useStore.getState();
  const params = decodeSettings(hash.slice(PREFIX.length));
  if (!params) {
    toast({ kind: 'error', icon: 'link', title: 'That settings link can’t be read', body: 'It may be cut off, or made by a newer version. Your settings are unchanged.' });
    return false;
  }
  store.setParams(params);
  linkLook = useStore.getState().params;
  // Said on arrival too, when the start screen has nothing to show the look on yet.
  toast(
    store.media.info
      ? { kind: 'info', icon: 'link', title: 'Applied settings from the link', body: `Undo (${shortcutLabel('edit.undo') || formatCombo('mod+z')}) restores your previous settings.` }
      : { kind: 'info', icon: 'link', title: 'Settings from the link are ready', body: 'Open a file or sample to see them.' },
  );
  return true;
}

/** Links pasted into the address bar of an open tab change only the hash: apply those too. */
export function listenForSettingsLinks(): () => void {
  const onHashChange = () => void applySettingsFromUrl();
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}

// UTF-8 safe base64url: custom glyph sets can hold any character.
function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
