import type { MediaKind } from '../media';

/**
 * The system file picker, without a permanent <input type="file"> in the DOM. Must be called
 * from a user gesture (click, keydown). Resolves null when the picker is dismissed.
 */
export const ACCEPT = 'image/*,video/*,.gif,.apng,.avif,.webp,.heic,.heif,.mov,.mkv,.m4v';

export function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** What a drag carries, judged from MIME types only (names are not exposed until the drop). */
export function classifyDrag(dt: DataTransfer): { files: boolean; supported: boolean; kind?: MediaKind } {
  if (!Array.from(dt.types).includes('Files')) return { files: false, supported: false };
  const item = Array.from(dt.items).find((i) => i.kind === 'file');
  const type = item?.type ?? '';
  if (type === 'image/gif') return { files: true, supported: true, kind: 'animation' };
  if (type.startsWith('image/')) return { files: true, supported: true, kind: 'image' };
  if (type.startsWith('video/')) return { files: true, supported: true, kind: 'video' };
  // Empty type: the OS did not say (common for .mov / .heic); let the drop decide by magic bytes.
  return { files: true, supported: type === '' };
}
