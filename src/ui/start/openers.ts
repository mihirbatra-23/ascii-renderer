/**
 * The ways in besides drop and ⌘V paste events, shared by the start screen, the top bar's Open
 * menu, the phone menu and the shortcuts: the system picker, the Paste button (async clipboard)
 * and the URL field. All end in controller.openFile; failures become toasts with the next step.
 *
 *   pickAndOpen()             the system file picker (call from a user gesture)
 *   pasteAndOpen()            the clipboard's image, or the link it holds
 *   pasteFromClipboard(onUrl) the same, handing a link to the caller (the URL field shows it)
 *   openUrl(text, signal)     download a linked file into this tab and open it
 */
import { openFile } from '../../app/controller';
import { pickFile } from '../../app/filePicker';
import { formatCombo } from '../../app/shortcuts';
import { MEDIA_LIMITS } from '../../media/types';
import { toast } from '../kit';
import { formatBytes } from '../stage/format';

export function pickAndOpen(): void {
  void pickFile().then((file) => file && openFile(file));
}

export function pasteAndOpen(): void {
  void pasteFromClipboard((link) => void openUrl(link, new AbortController().signal));
}

const PASTE = () => formatCombo('mod+v');

/**
 * Reads the clipboard on a click. An image opens; a copied link is handed to `onUrl` (the URL
 * field loads it). Browsers that refuse clipboard reads still deliver ⌘V paste events, so say so.
 */
export async function pasteFromClipboard(onUrl: (url: string) => void): Promise<void> {
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    toast({ kind: 'info', icon: 'paste', title: 'Clipboard access is off', body: `Press ${PASTE()} to paste instead.` });
    return;
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/') || t.startsWith('video/'));
    if (type) {
      const blob = await item.getType(type);
      // The name is cosmetic (the top bar shows it); the format is sniffed from the bytes.
      void openFile(new File([blob], `pasted image.${type.split('/')[1].split('+')[0].replace('jpeg', 'jpg')}`, { type }));
      return;
    }
  }
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue;
    const text = (await (await item.getType('text/plain')).text()).trim();
    if (parseHttpUrl(text)) return onUrl(text);
  }
  toast({ kind: 'info', icon: 'paste', title: 'Nothing to paste', body: 'Copy an image, video or link, then try again.' });
}

export function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function fileNameOf(url: URL, type: string): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = type.split('/')[1]?.split(';')[0];
  return `${last || url.hostname}${ext ? `.${ext}` : ''}`;
}

/** A typed address without a scheme ('example.com/a.png') is read as https. */
function typedUrl(text: string): URL | null {
  const trimmed = text.trim();
  return parseHttpUrl(trimmed) ?? (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(trimmed) ? parseHttpUrl(`https://${trimmed}`) : null);
}

/**
 * Downloads the file into this tab and opens it. Nothing is uploaded: the request is a plain GET
 * to the server the user named, and it only succeeds when that server allows cross-origin reads.
 */
export async function openUrl(text: string, signal: AbortSignal): Promise<void> {
  const url = typedUrl(text);
  if (!url) {
    toast({ kind: 'error', title: 'That isn’t a web address', body: 'Use a link like https://example.com/image.png.' });
    return;
  }
  // Browsers block plain-http downloads from an https page; say so instead of a vague failure.
  if (url.protocol === 'http:' && window.location.protocol === 'https:') {
    toast({ kind: 'error', title: 'That link isn’t secure', body: 'Only https:// links can be loaded. Download the file and open it instead.' });
    return;
  }
  let blob: Blob;
  try {
    const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) {
      toast({ kind: 'error', title: `Couldn’t load ${url.hostname}`, body: `The server returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. Check the link and try again.` });
      return;
    }
    // Refused before downloading when the server says how big it is (the media limit applies anyway).
    const length = Number(res.headers.get('content-length'));
    if (length > MEDIA_LIMITS.maxFileBytes) {
      void res.body?.cancel();
      toast({ kind: 'error', title: 'That file is too large', body: `It’s ${formatBytes(length)}. The limit is ${MEDIA_LIMITS.maxFileBytes / 1024 ** 3} GB.` });
      return;
    }
    blob = await res.blob();
  } catch {
    if (signal.aborted) return;
    toast({
      kind: 'error',
      title: `Couldn’t load ${url.hostname}`,
      body: 'The server can’t be reached or blocks other sites. Download the file and open it instead.',
    });
    return;
  }
  await openFile(new File([blob], fileNameOf(url, blob.type), { type: blob.type }));
}
