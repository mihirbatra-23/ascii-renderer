/** Single entry point: any dropped / pasted / picked file → LoadedMedia, routed by magic bytes. */
import { loadAnimatedImage, supportsAnimatedDecode } from './animated-image';
import { countGifFrames, GIF_NO_FRAMES, SNIFF_HEAD_BYTES, sniffFormat } from './detect';
import { loadImage } from './image';
import { assertFileSize } from './limits';
import { MediaError, type LoadedMedia } from './types';
import { loadVideo } from './video';

export async function loadMedia(file: Blob, name = file instanceof File ? file.name : 'pasted image'): Promise<LoadedMedia> {
  assertFileSize(file.size);
  const head = new Uint8Array(await file.slice(0, SNIFF_HEAD_BYTES).arrayBuffer());
  const { kind, format } = sniffFormat(head);

  if (format === 'GIF') {
    // Whether a GIF is animated is only certain from the whole file (the first frame may be large).
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frames = countGifFrames(bytes, 2);
    // Checked before the header's size: a damaged file's header can claim any size, and "too large"
    // would send the user to resize a file that cannot be read at all.
    if (frames === 0) throw new MediaError('decode-failed', GIF_NO_FRAMES);
    if (frames === 1) return loadImage(file, name, format, head);
    // The GIF decoder (gifuct-js) loads on first use, keeping it out of the app's first chunk.
    const { loadGif } = await import('./gif');
    return loadGif(bytes, name);
  }

  switch (kind) {
    case 'video':
      return loadVideo(file, name, format);
    case 'animation':
      if (await supportsAnimatedDecode(format)) {
        return loadAnimatedImage(new Uint8Array(await file.arrayBuffer()), name, format);
      }
      // Without ImageDecoder the browser's still decoders yield the first frame; say so in the label.
      return loadImage(file, name, format, head, `${format} · first frame`);
    case 'image':
      return loadImage(file, name, format, head);
    case 'unknown':
      throw new MediaError('unsupported-format', 'Use PNG, JPG, WEBP, AVIF, GIF, SVG, MP4, WEBM or MOV.');
  }
}
