import { FONTS } from '../engine/fonts';
import type { FontId } from '../engine/types';
import { fetchEmbeddedFont, type EmbeddedFont } from './font-embed';

const cache = new Map<FontId, Promise<EmbeddedFont>>();

/** The bundled WOFF2 of `id` (same-origin asset from the engine's FONTS registry), fetched once. */
export function bundledFont(id: FontId): Promise<EmbeddedFont> {
  let font = cache.get(id);
  if (!font) {
    const { woff2Url, name } = FONTS[id];
    font = fetchEmbeddedFont(woff2Url, name);
    font.catch(() => cache.delete(id));
    cache.set(id, font);
  }
  return font;
}
