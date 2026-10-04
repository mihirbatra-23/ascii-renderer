/**
 * Bundled fonts (latin subset, weight 400), served from the app's own origin: no runtime network
 * requests to third parties.
 *
 * Public API
 *   FONTS[id]     { name, family, label, woff2Url }: `name` is the bare family name (FontFace),
 *                 `family` the CSS font-family value used for drawing (CellGeometry.fontFamily)
 *   loadFont(id)  registers the face with the document (or worker) and resolves once it is usable;
 *                 idempotent
 */
import type { FontId } from './types';
import jetbrainsMono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import ibmPlexMono from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import geistMono from '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2?url';

export interface BundledFont {
  name: string;
  family: string;
  label: string;
  woff2Url: string;
}

const font = (name: string, woff2Url: string): BundledFont => ({ name, family: `"${name}"`, label: name, woff2Url });

export const FONTS: Record<FontId, BundledFont> = {
  'jetbrains-mono': font('JetBrains Mono', jetbrainsMono),
  'ibm-plex-mono': font('IBM Plex Mono', ibmPlexMono),
  'geist-mono': font('Geist Mono', geistMono),
};

const loading = new Map<FontId, Promise<void>>();

export function loadFont(id: FontId): Promise<void> {
  let p = loading.get(id);
  if (!p) {
    const { name, woff2Url } = FONTS[id];
    const fontSet = (globalThis as { fonts?: FontFaceSet }).fonts ?? globalThis.document?.fonts;
    if (!fontSet) return Promise.reject(new Error('Font loading needs a document or worker FontFaceSet'));
    const face = new FontFace(name, `url(${JSON.stringify(woff2Url)}) format("woff2")`, { weight: '400', style: 'normal' });
    p = face.load().then((loaded) => {
      fontSet.add(loaded);
    });
    // Let a failed load be retried instead of caching the rejection forever.
    p.catch(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}
