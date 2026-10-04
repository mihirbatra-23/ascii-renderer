import { quantize } from 'gifenc';
import { gifPairBytes } from './gif-pair';
import { PaletteMapper } from './gif-palette';
import { GifWriter } from './gif-writer';
import type { RasterReply, RasterRequest } from './raster-protocol';
import { resampleArea, type OwnedPixels } from './resample';

/**
 * Raster work that would otherwise block the main thread: shrinking to an exact width, PNG encoding
 * (OffscreenCanvas.convertToBlob here runs on this thread, not in the page's idle time) and measuring
 * what a frame costs as PNG / GIF for the size estimate.
 */

const SAMPLE_PIXELS = 1 << 16;

function pixelsOf(request: { width: number; height: number; rgba: ArrayBuffer }): OwnedPixels {
  const data = new Uint8ClampedArray(request.rgba);
  if (data.length !== request.width * request.height * 4) throw new Error('Raster size does not match its pixels.');
  return { width: request.width, height: request.height, data };
}

async function pngBlob(pixels: OwnedPixels): Promise<Blob> {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
  ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Bytes of one full GIF frame of `pixels` with an adaptive palette (what the first frame of a GIF costs). */
function gifFrameBytes(pixels: OwnedPixels): number {
  const stride = Math.max(1, Math.ceil((pixels.width * pixels.height) / SAMPLE_PIXELS));
  const sample = new Uint8Array(Math.ceil((pixels.width * pixels.height) / stride) * 4);
  for (let p = 0, o = 0; o < sample.length; p += stride, o += 4) sample.set(pixels.data.subarray(p * 4, p * 4 + 4), o);
  const palette = quantize(sample, 255);
  const writer = new GifWriter(pixels.width, pixels.height, palette, 0);
  writer.writeFrame(new PaletteMapper(palette).map(pixels.data), { x: 0, y: 0, width: pixels.width, height: pixels.height }, { delayCs: 4, disposal: 1 });
  return writer.finish().byteLength;
}

async function handle(request: RasterRequest): Promise<RasterReply> {
  const pixels = pixelsOf(request);
  switch (request.op) {
    case 'png': {
      const out = request.target ? resampleArea(pixels, request.target) : pixels;
      return { id: request.id, op: 'png', blob: await pngBlob(out) };
    }
    case 'resize': {
      const out = resampleArea(pixels, request.target);
      return { id: request.id, op: 'resize', width: out.width, height: out.height, rgba: out.data.buffer };
    }
    case 'measure':
      return { id: request.id, op: 'measure', pngBytes: (await pngBlob(pixels)).size, gifFrameBytes: gifFrameBytes(pixels) };
    case 'gifPair': {
      const next = { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(request.next) };
      return { id: request.id, op: 'gifPair', ...gifPairBytes(pixels, next, request.palette, request.paper) };
    }
  }
}

self.onmessage = async (event: MessageEvent<RasterRequest>) => {
  const request = event.data;
  try {
    const reply = await handle(request);
    self.postMessage(reply, { transfer: reply.op === 'resize' ? [reply.rgba] : [] });
  } catch (error) {
    const reply: RasterReply = { id: request.id, op: 'error', message: error instanceof Error ? error.message : String(error) };
    self.postMessage(reply);
  }
};
