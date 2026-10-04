import type { AsciiEngine, RasterPixels, RenderParams } from '../engine/types';
import { parseHex, unpack } from './color';
import { ExportError, throwIfAborted, withAbort } from './errors';
import { exportFileName } from './filename';
import type { ExportFrame, FrameInput } from './frames';
import { DelayAccumulator, fixedPalette, usesFixedPalette } from './gif-palette';
import type { GifRequest, GifResponse, GifStartMessage } from './gif-protocol';
import { planOutput, readPlanned, type OutputPlan } from './output';
import { transferableBytes } from './pixels';
import { FrameProgress, type ProgressCallback } from './progress';
import type { ExportOptions, ExportResult } from './types';
import { yieldToEventLoop } from './yield';

export interface GifExportOptions extends Pick<ExportOptions, 'scale' | 'margin' | 'targetWidth'> {
  /**
   * NETSCAPE repeat count: -1 = play once (no extension), 0 = loop forever (default), n = n + 1
   * plays. LoadedAnimation.loopCount counts total plays instead: convert it with gifRepeatCount().
   */
  loopCount?: number;
  /** Number of frames the iterable will yield, for progress and ETA (and a warning if fewer arrive). */
  frameCount?: number;
  /**
   * Source-colour renders only: frames spread across the clip to build the single global palette
   * from (animationSamples / videoSamples). Without them the first frames are buffered and sampled
   * before encoding starts, so colours that appear later in the clip are approximated.
   */
  paletteSamples?: AsyncIterable<FrameInput> | Iterable<FrameInput>;
  /** Source file name, for the download name. */
  sourceName?: string;
  /**
   * The colours the engine renders with, as the caller set them. Without them they are read from
   * the engine's snapshot, a synchronous readback of the whole grid on the export's first frame.
   */
  params?: Pick<RenderParams, 'colorMode' | 'ink' | 'paper' | 'shadowInk'>;
}

/** Frames handed to the worker but not yet taken; bounds memory to a few raw frames. */
const MAX_IN_FLIGHT = 3;
/** Frames buffered to sample an adaptive palette when no samples arrive (none given, or none decodable). */
const BUFFERED_SAMPLE_FRAMES = 8;

class GifWorkerClient {
  private readonly worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' });
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private failure: Error | null = null;
  readonly done: Promise<ArrayBuffer>;

  constructor(onEncoded: (frames: number) => void) {
    this.done = new Promise<ArrayBuffer>((resolve, reject) => {
      const fail = (error: Error) => {
        this.failure = error;
        this.wake();
        reject(error);
      };
      this.worker.onmessage = (event: MessageEvent<GifResponse>) => {
        const msg = event.data;
        if (msg.type === 'ack') {
          this.inFlight--;
          this.wake();
        } else if (msg.type === 'encoded') onEncoded(msg.frames);
        else if (msg.type === 'done') resolve(msg.bytes);
        else {
          console.error(`GIF encoding failed: ${msg.message}`);
          fail(new ExportError('encode-failed', 'GIF encoding failed. Try again.'));
        }
      };
      this.worker.onerror = (event) => {
        console.error(`GIF encoder crashed: ${event.message}`);
        fail(new ExportError('encode-failed', 'GIF encoding failed. Try again.'));
      };
    });
    // Failures are re-thrown from send()/done; this only silences the unhandled-rejection report.
    this.done.catch(() => undefined);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async send(message: GifRequest, signal: AbortSignal | undefined, transfer: Transferable[] = []): Promise<void> {
    const counted = message.type === 'frame' || message.type === 'sample';
    while (counted && this.inFlight >= MAX_IN_FLIGHT && !this.failure) {
      await withAbort(new Promise<void>((resolve) => this.waiters.push(resolve)), signal);
    }
    if (this.failure) throw this.failure;
    if (counted) this.inFlight++;
    this.worker.postMessage(message, transfer);
  }

  /** Hands the raster's pixels to the worker without copying them. */
  sendPixels(type: 'sample', pixels: RasterPixels, signal: AbortSignal | undefined): Promise<void>;
  sendPixels(type: 'frame', pixels: RasterPixels, signal: AbortSignal | undefined, delayCs: number): Promise<void>;
  sendPixels(type: 'sample' | 'frame', pixels: RasterPixels, signal: AbortSignal | undefined, delayCs = 0): Promise<void> {
    const rgba = transferableBytes(pixels);
    return this.send(type === 'frame' ? { type, rgba, delayCs } : { type, rgba }, signal, [rgba]);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/**
 * Animated GIF of `frames`, each rendered by the engine at the export size (async readback) and
 * encoded in a worker with one global palette (fixed for mono/duotone, quantized once for source
 * colour) so colours never shimmer; frames after the first store only what changed. Delays are
 * carried forward in centiseconds; the loop count is written as given. The main thread yields after
 * every frame and checks `signal` before each one, so the editor stays usable and Cancel is
 * immediate (AbortError). Each yielded frame is used before the next is requested, as the frame
 * sources in frames.ts expect. The engine's history is reset before and after; its source is left
 * on the last exported frame (which the frame source may have released: re-show the current frame).
 */
export async function exportGif(
  engine: AsciiEngine,
  frames: AsyncIterable<ExportFrame>,
  opts: GifExportOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<ExportResult> {
  throwIfAborted(signal);
  const progress = new FrameProgress(opts.frameCount, onProgress);
  const delays = new DelayAccumulator();
  const warnings: string[] = [];
  const iterator = frames[Symbol.asyncIterator]();
  let worker: GifWorkerClient | null = null;
  let finished = false;
  engine.resetHistory();
  try {
    let next = await withAbort(iterator.next(), signal);
    if (next.done) throw new ExportError('empty', 'No frames to export.');
    engine.setSource(next.value.source, next.value.info);
    // Planned once the engine has a frame of the clip: the grid follows the source's size.
    const plan = planOutput(engine, { ...opts, transparentBackground: false });
    // The palette must match what the engine renders: the caller's params are the ones it set.
    const params = opts.params ?? engine.snapshot().params;
    const fixed = usesFixedPalette(params);
    const client = new GifWorkerClient((n) => progress.report(n));
    worker = client;
    await client.send(startMessage(plan, opts, fixed ? fixedPalette(params) : null, params.paper), signal);

    if (!fixed && opts.paletteSamples) {
      for await (const sample of opts.paletteSamples) {
        throwIfAborted(signal);
        engine.resetHistory();
        engine.setSource(sample.source, sample.info);
        await client.sendPixels('sample', await readPlanned(engine, plan, signal), signal);
      }
      // Sampling disturbed the temporal history; render the first frame from a clean state.
      engine.resetHistory();
      engine.setSource(next.value.source, next.value.info);
    }

    let count = 0;
    while (!next.done) {
      throwIfAborted(signal);
      if (count > 0) engine.setSource(next.value.source, next.value.info);
      const pixels = await readPlanned(engine, plan, signal);
      await client.sendPixels('frame', pixels, signal, delays.next(next.value.durationMs));
      count++;
      // The frame has been read back, so its source may be released now.
      next = await withAbort(iterator.next(), signal);
      await yieldToEventLoop();
    }
    finished = true;
    if (opts.frameCount !== undefined && count < opts.frameCount) {
      warnings.push(`Only ${count} of ${opts.frameCount} frames could be read. The GIF is shorter.`);
    }

    await client.send({ type: 'finish' }, signal);
    progress.finishing();
    const bytes = await withAbort(client.done, signal);
    return {
      blob: new Blob([bytes], { type: 'image/gif' }),
      fileName: exportFileName(opts.sourceName ?? 'animation', plan.grid, 'gif'),
      width: plan.size.width,
      height: plan.size.height,
      warnings,
    };
  } finally {
    worker?.terminate();
    // Let the frame source release decoders when we stop early (error or cancel).
    if (!finished) await iterator.return?.();
    engine.resetHistory();
  }
}

function startMessage(plan: OutputPlan, opts: GifExportOptions, palette: GifStartMessage['palette'], paper: string): GifStartMessage {
  return {
    type: 'start',
    width: plan.size.width,
    height: plan.size.height,
    rasterWidth: plan.rasterSize.width,
    rasterHeight: plan.rasterSize.height,
    loopCount: opts.loopCount ?? 0,
    palette,
    paper: unpack(parseHex(paper)),
    bufferFrames: BUFFERED_SAMPLE_FRAMES,
  };
}
