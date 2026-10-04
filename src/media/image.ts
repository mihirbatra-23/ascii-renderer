/** Still images → LoadedImage, with EXIF orientation applied and alpha preserved. */
import { context2d, hasVisibleAlpha } from './canvas';
import { readImageHeader } from './header';
import { lifetimeMembers } from './lifetime';
import { assertImagePixels } from './limits';
import { svgRasterSize, type PixelSize } from './svg-size';
import type { PixelBox, ResizeReply, ResizeRequest } from './resize-protocol';
import { MediaError, type LoadedImage } from './types';

const BITMAP_OPTIONS: ImageBitmapOptions = {
  imageOrientation: 'from-image',
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'default',
};

/** Long side of LoadedImage.thumbnail. */
const THUMBNAIL_SIDE = 512;
/**
 * Widest LoadedImage.bitmap. The widest analysis is 400 columns × 8 sub-pixels = 3200 px (and the
 * height follows the aspect), so wider pixels only cost upload time: a 64 MP bitmap blocked the
 * main thread for ~150 ms in texImage2D. Shrinking happens off the main thread.
 */
const SOURCE_MAX_WIDTH = 4096;

const MIME_TYPES: Record<string, string> = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  APNG: 'image/png', // the registered image/apng is not accepted by every decoder API
  GIF: 'image/gif',
  WebP: 'image/webp',
  AVIF: 'image/avif',
  HEIC: 'image/heic',
  HEIF: 'image/heif',
  BMP: 'image/bmp',
  ICO: 'image/x-icon',
  SVG: 'image/svg+xml',
};

export function imageMimeType(format: string): string {
  return MIME_TYPES[format] ?? 'application/octet-stream';
}

const HEIC_MESSAGE =
  "This browser can't open HEIC photos. In Photos, export it as JPEG or PNG (File › Export) and drop that file here instead.";

/**
 * @param head  The first bytes of the file (for the header size / alpha checks).
 * @param formatLabel  UI label; defaults to the format (e.g. 'WebP · first frame' for a fallback).
 */
export async function loadImage(
  file: Blob,
  name: string,
  format: string,
  head: Uint8Array,
  formatLabel = format,
): Promise<LoadedImage> {
  const header = readImageHeader(head, format);
  if (header) assertImagePixels(header.width, header.height);

  const typed = new Blob([file], { type: imageMimeType(format) });
  const decoded = format === 'SVG' ? await rasterizeSvg(typed) : await decodeBitmap(typed, format);
  // The picture's own size, whatever size its bitmap is kept at.
  const { width, height } = decoded;
  let bitmap: ImageBitmap;
  let thumbnail: ImageBitmap;
  try {
    assertImagePixels(width, height);
    ({ bitmap, thumbnail } = await sizedForAnalysis(decoded));
  } catch (error) {
    decoded.close();
    throw error;
  }

  return {
    kind: 'image',
    name,
    width,
    height,
    fileSize: file.size,
    formatLabel,
    hasAlpha: (header?.mayHaveAlpha ?? true) && hasVisibleAlpha(thumbnail, thumbnail.width, thumbnail.height),
    bitmap,
    thumbnail,
    ...lifetimeMembers(() => {
      thumbnail.close();
      bitmap.close();
    }),
  };
}

/** `size` scaled so its long side is at most `side`, or null when it already is. */
function fitted(size: PixelBox, side: number, by: 'width' | 'long'): PixelBox | null {
  const edge = by === 'width' ? size.width : Math.max(size.width, size.height);
  if (edge <= side) return null;
  const k = side / edge;
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

/**
 * The picture at most SOURCE_MAX_WIDTH wide and its ≤ 512 px analysis thumbnail, both resized in a
 * worker (resize.worker.ts): on the main thread each resize of a 64 MP bitmap is a 100–250 ms task.
 * `bitmap` is handed over (closed when it is replaced); without a worker, or if resizing fails, the
 * picture stays as decoded and the thumbnail is made here.
 */
async function sizedForAnalysis(bitmap: ImageBitmap): Promise<{ bitmap: ImageBitmap; thumbnail: ImageBitmap }> {
  const source = fitted(bitmap, SOURCE_MAX_WIDTH, 'width');
  const thumbnail = fitted(source ?? bitmap, THUMBNAIL_SIDE, 'long');
  if (!source && !thumbnail) return { bitmap, thumbnail: bitmap };
  if (typeof Worker === 'undefined') return { bitmap, thumbnail: await thumbnailOf(bitmap) };
  const worker = new Worker(new URL('./resize.worker.ts', import.meta.url), { type: 'module' });
  try {
    const reply = await new Promise<ResizeReply>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ResizeReply>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ bitmap, source, thumbnail } satisfies ResizeRequest, [bitmap]);
    });
    if (reply.ok) return { bitmap: reply.bitmap, thumbnail: reply.thumbnail };
    return { bitmap: reply.bitmap, thumbnail: await thumbnailOf(reply.bitmap) };
  } finally {
    worker.terminate();
  }
}

/** The ≤ 512 px thumbnail made on this thread: sizedForAnalysis's fallback when the worker is unavailable. */
async function thumbnailOf(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const size = fitted(bitmap, THUMBNAIL_SIDE, 'long');
  if (!size) return bitmap;
  return createImageBitmap(bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium', premultiplyAlpha: 'none' });
}

async function decodeBitmap(blob: Blob, format: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, BITMAP_OPTIONS);
  } catch {
    if (format === 'HEIC' || format === 'HEIF') {
      // Safari can show HEIC in <img> on versions where createImageBitmap rejects it.
      try {
        return await drawImageElement(blob);
      } catch {
        throw new MediaError('heic-unsupported', HEIC_MESSAGE);
      }
    }
    throw new MediaError(
      'decode-failed',
      `This ${format} file could not be decoded. It may be damaged, or use a variant this browser can't read.`,
    );
  }
}

/** SVG goes through <img> (createImageBitmap rejects SVG blobs) into an explicitly sized canvas. */
async function rasterizeSvg(blob: Blob): Promise<ImageBitmap> {
  const size = svgRasterSize(await blob.text());
  assertImagePixels(size.width, size.height);
  try {
    return await drawImageElement(blob, size);
  } catch {
    throw new MediaError('decode-failed', 'This SVG could not be drawn. It may be malformed.');
  }
}

/** Decodes via an <img> element; `size` overrides the natural size (vector sources). */
async function drawImageElement(blob: Blob, size?: PixelSize): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = size?.width ?? img.naturalWidth;
    const height = size?.height ?? img.naturalHeight;
    if (!width || !height) throw new Error('Image has no size.');
    const canvas = new OffscreenCanvas(width, height);
    context2d(canvas).drawImage(img, 0, 0, width, height);
    return canvas.transferToImageBitmap();
  } finally {
    URL.revokeObjectURL(url);
  }
}
