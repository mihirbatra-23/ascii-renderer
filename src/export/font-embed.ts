/** A bundled font to inline into standalone HTML / SVG-text exports. */
export interface EmbeddedFont {
  /** Family name without quotes, e.g. 'JetBrains Mono'. */
  family: string;
  /** WOFF2 bytes. */
  data: Uint8Array;
}

/** First family of a CSS font-family list, unquoted ('"JetBrains Mono", monospace' → 'JetBrains Mono'). */
export function primaryFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim() ?? '';
  return first.replace(/^(["'])(.*)\1$/, '$2') || 'monospace';
}

export function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so String.fromCharCode never exceeds the engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** @font-face rule with the font inlined as a data URL (exports must work offline and stand alone). */
export function fontFaceCss(font: EmbeddedFont): string {
  return (
    `@font-face{font-family:${cssString(font.family)};` +
    `src:url(data:font/woff2;base64,${bytesToBase64(font.data)}) format("woff2");` +
    'font-weight:400;font-style:normal;font-display:block}'
  );
}

/** Code ligatures (JetBrains Mono's `calt`) would merge cells such as `->`; exports must stay one glyph per cell. */
export const NO_LIGATURES_CSS = 'font-kerning:none;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0';

/** Browser helper: fetch a bundled font URL (e.g. a Vite asset URL) for embedding. */
export async function fetchEmbeddedFont(url: string, family: string): Promise<EmbeddedFont> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load font ${url} (${response.status})`);
  return { family, data: new Uint8Array(await response.arrayBuffer()) };
}
