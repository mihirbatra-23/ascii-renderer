/** Clipboard helpers. All must be called from a user gesture (click / key press). */

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Insecure contexts have no async clipboard; the legacy path still works there.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy is not available in this browser');
}

/**
 * Copies a PNG. Accepts a promise so the ClipboardItem is created synchronously inside the gesture
 * (Safari rejects writes whose item is created after an await).
 */
export async function copyPng(png: Blob | Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('Copying images is not supported in this browser; use Download instead');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/**
 * Copies SVG markup as text/plain (what Figma and code editors read) and, where the browser allows
 * it, also as image/svg+xml for apps that paste images.
 */
export async function copySvg(svg: string): Promise<void> {
  const canWriteSvg =
    typeof ClipboardItem !== 'undefined' &&
    typeof ClipboardItem.supports === 'function' &&
    ClipboardItem.supports('image/svg+xml') &&
    !!navigator.clipboard?.write;
  if (!canWriteSvg) {
    await copyText(svg);
    return;
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([svg], { type: 'text/plain' }),
      'image/svg+xml': new Blob([svg], { type: 'image/svg+xml' }),
    }),
  ]);
}
