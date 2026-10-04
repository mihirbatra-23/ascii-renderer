import type { RasterPixels } from '../engine/types';
import { ExportError, withAbort } from './errors';
import type { PixelSize } from './geometry';
import { transferableBytes } from './pixels';
import type { RasterReply, RasterRequest } from './raster-protocol';
import type { Palette } from './gif-palette';
import type { OwnedPixels } from './resample';

/** The user-facing failure; the worker's own message goes to the console. */
const PROCESS_FAILED = 'The image couldn’t be processed. Try again.';

type Settle = { resolve: (reply: RasterReply) => void; reject: (error: Error) => void };

/** Distributes Omit over the request union so each op keeps its own fields. */
type RequestBody = RasterRequest extends infer R ? (R extends RasterRequest ? Omit<R, 'id' | 'rgba' | 'width' | 'height'> : never) : never;

/**
 * Main-thread handle on raster.worker.ts. Each call transfers the raster's pixels (the caller must
 * not use them afterwards) and resolves with the worker's result. terminate() rejects what is pending.
 */
export class RasterWorker {
  private readonly worker = new Worker(new URL('./raster.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Settle>();
  private nextId = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<RasterReply>) => {
      const reply = event.data;
      const settle = this.pending.get(reply.id);
      if (!settle) return;
      this.pending.delete(reply.id);
      if (reply.op === 'error') {
        console.error(`Image processing failed: ${reply.message}`);
        settle.reject(new ExportError('encode-failed', PROCESS_FAILED));
      } else settle.resolve(reply);
    };
    this.worker.onerror = (event) => {
      console.error(`Image worker crashed: ${event.message}`);
      this.failAll(new ExportError('encode-failed', PROCESS_FAILED));
    };
  }

  /** PNG of `pixels`, shrunk to `target` first when it differs from the raster. */
  async png(pixels: RasterPixels, target: PixelSize | undefined, signal?: AbortSignal): Promise<Blob> {
    const resize = target && (target.width !== pixels.width || target.height !== pixels.height) ? target : undefined;
    const reply = await this.request(pixels, { op: 'png', target: resize }, signal);
    if (reply.op !== 'png') throw new Error(`Unexpected ${reply.op} reply`);
    return reply.blob;
  }

  /** `pixels` shrunk to `target` with the linear-light area filter. */
  async resize(pixels: RasterPixels, target: PixelSize, signal?: AbortSignal): Promise<OwnedPixels> {
    const reply = await this.request(pixels, { op: 'resize', target }, signal);
    if (reply.op !== 'resize') throw new Error(`Unexpected ${reply.op} reply`);
    return { width: reply.width, height: reply.height, data: new Uint8ClampedArray(reply.rgba) };
  }

  /** Encoded sizes of `pixels`: as a PNG, and as one full GIF frame with an adaptive palette. */
  async measure(pixels: RasterPixels, signal?: AbortSignal): Promise<{ pngBytes: number; gifFrameBytes: number }> {
    const reply = await this.request(pixels, { op: 'measure' }, signal);
    if (reply.op !== 'measure') throw new Error(`Unexpected ${reply.op} reply`);
    return { pngBytes: reply.pngBytes, gifFrameBytes: reply.gifFrameBytes };
  }

  /**
   * GIF bytes of `pixels` as a first frame and of `next` (the following frame, same size) as the
   * delta after it, encoded as the GIF exporter encodes (`palette` null = adaptive).
   */
  async gifPair(
    pixels: RasterPixels,
    next: RasterPixels,
    palette: Palette | null,
    paper: [number, number, number],
    signal?: AbortSignal,
  ): Promise<{ firstBytes: number; deltaBytes: number }> {
    const nextBytes = transferableBytes(next);
    const reply = await this.request(pixels, { op: 'gifPair', next: nextBytes, palette, paper }, signal, [nextBytes]);
    if (reply.op !== 'gifPair') throw new Error(`Unexpected ${reply.op} reply`);
    return { firstBytes: reply.firstBytes, deltaBytes: reply.deltaBytes };
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new ExportError('encode-failed', PROCESS_FAILED));
  }

  private request(pixels: RasterPixels, body: RequestBody, signal: AbortSignal | undefined, transfer: Transferable[] = []): Promise<RasterReply> {
    const id = this.nextId++;
    const rgba = transferableBytes(pixels);
    const reply = new Promise<RasterReply>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ ...body, id, width: pixels.width, height: pixels.height, rgba } as RasterRequest, [rgba, ...transfer]);
    return withAbort(reply, signal);
  }

  private failAll(error: Error): void {
    for (const settle of this.pending.values()) settle.reject(error);
    this.pending.clear();
  }
}
