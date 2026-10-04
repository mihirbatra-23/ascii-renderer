import { quantize } from 'gifenc';
import { FrameDiffer } from './gif-delta';
import { PaletteMapper, samplePixels, snapToPalette, withTransparentSlot, type Palette } from './gif-palette';
import type { GifRequest, GifResponse, GifStartMessage } from './gif-protocol';
import { GifWriter } from './gif-writer';
import { resampleArea } from './resample';

/**
 * GIF encoding off the main thread: optional resample to the exact width, palette mapping, inter-frame
 * delta and LZW, with one global palette (fixed, or quantized once from samples spread over the clip).
 */

const SAMPLE_PIXELS_PER_FRAME = 1 << 16;
/** One palette slot stays free for the transparent index of delta frames. */
const ADAPTIVE_COLORS = 255;

interface Encoder {
  writer: GifWriter;
  mapper: PaletteMapper;
  differ: FrameDiffer;
  transparentIndex: number;
}

let config: GifStartMessage | null = null;
let palette: Palette | null = null;
let encoder: Encoder | null = null;
let encoded = 0;
const samples: Uint8Array[] = [];
/** Whether 'sample' messages came (the palette is then built from them, not from buffered frames). */
let sampled = false;
const pending: Array<{ rgba: Uint8ClampedArray; delayCs: number }> = [];

function post(message: GifResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

/** The raster at the GIF's size (shrunk in linear light when an exact width was asked for). */
function outputPixels(cfg: GifStartMessage, rgba: ArrayBuffer): Uint8ClampedArray {
  const raster = { width: cfg.rasterWidth, height: cfg.rasterHeight, data: new Uint8ClampedArray(rgba) };
  if (raster.data.length !== raster.width * raster.height * 4) throw new Error('Frame size does not match the GIF.');
  if (cfg.rasterWidth === cfg.width && cfg.rasterHeight === cfg.height) return raster.data;
  return resampleArea(raster, { width: cfg.width, height: cfg.height }).data;
}

function buildPalette(cfg: GifStartMessage): Palette {
  const total = samples.reduce((n, s) => n + s.length, 0);
  if (total === 0) return [cfg.paper];
  const all = new Uint8Array(total);
  let offset = 0;
  for (const s of samples) {
    all.set(s, offset);
    offset += s.length;
  }
  samples.length = 0;
  return snapToPalette(quantize(all, ADAPTIVE_COLORS), cfg.paper);
}

function encoderFor(cfg: GifStartMessage, pal: Palette): Encoder {
  const { table, transparentIndex } = withTransparentSlot(pal, cfg.paper);
  return {
    writer: new GifWriter(cfg.width, cfg.height, table, cfg.loopCount),
    mapper: new PaletteMapper(pal, cfg.paper),
    differ: new FrameDiffer(cfg.width, cfg.height, transparentIndex),
    transparentIndex,
  };
}

function encode(enc: Encoder, frame: { rgba: Uint8ClampedArray; delayCs: number }): void {
  const delta = enc.differ.next(enc.mapper.map(frame.rgba));
  enc.writer.writeFrame(delta.indices, delta.rect, {
    delayCs: frame.delayCs,
    // Disposal 1 keeps each frame under the next, which draws only what changed.
    disposal: 1,
    transparentIndex: delta.transparent ? enc.transparentIndex : undefined,
  });
  encoded++;
  post({ type: 'encoded', frames: encoded });
}

function flushPending(cfg: GifStartMessage): Encoder {
  palette ??= buildPalette(cfg);
  encoder ??= encoderFor(cfg, palette);
  for (const frame of pending.splice(0)) encode(encoder, frame);
  return encoder;
}

function handle(msg: GifRequest): void {
  if (msg.type === 'start') {
    config = msg;
    palette = msg.palette;
    encoder = palette ? encoderFor(msg, palette) : null;
    return;
  }
  if (!config) throw new Error('GIF worker used before start');
  switch (msg.type) {
    case 'sample':
      sampled = true;
      samples.push(samplePixels(outputPixels(config, msg.rgba), SAMPLE_PIXELS_PER_FRAME));
      post({ type: 'ack' });
      break;
    case 'frame': {
      const frame = { rgba: outputPixels(config, msg.rgba), delayCs: msg.delayCs };
      if (!encoder && sampled) encoder = flushPending(config);
      if (encoder) {
        encode(encoder, frame);
      } else {
        pending.push(frame);
        if (config.bufferFrames > 0) samples.push(samplePixels(frame.rgba, SAMPLE_PIXELS_PER_FRAME));
        if (pending.length >= Math.max(1, config.bufferFrames)) flushPending(config);
      }
      post({ type: 'ack' });
      break;
    }
    case 'finish': {
      const bytes = flushPending(config).writer.finish();
      post({ type: 'done', bytes: bytes.buffer }, [bytes.buffer]);
      break;
    }
  }
}

self.onmessage = (event: MessageEvent<GifRequest>) => {
  try {
    handle(event.data);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
