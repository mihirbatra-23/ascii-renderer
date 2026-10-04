/**
 * Asynchronous GPU → CPU readback (WebGL2): readPixels into a PIXEL_PACK_BUFFER returns at once, a
 * fence marks the copy, and the fence is polled with a zero timeout across tasks, so the main
 * thread never waits for the GPU; getBufferSubData then copies the finished bytes.
 *
 * Public API
 *   PackBuffers                     reusable PIXEL_PACK_BUFFER objects; every buffer handed out has
 *                                   fresh storage (see acquire)
 *     acquire(bytes) → WebGLBuffer  at least `bytes` long, bound to PIXEL_PACK_BUFFER
 *     release(buffer)               back to the pool (large ones are freed instead)
 *     dispose()                     frees pooled buffers now, buffers still acquired on release
 *   fenceAndWait(gl)                → Promise<void> once all commands issued so far have completed;
 *                                     rejects if the context is lost meanwhile
 */
import type { GL } from './gl';

/** Buffers up to this size are kept for reuse (a 2560 × 1344 export frame is 13.8 MB). */
const KEEP_BYTES = 32 << 20;
const KEEP_COUNT = 3;
/** Poll interval while the GPU works (ms). */
const POLL_MS = 1;

interface Entry {
  buffer: WebGLBuffer;
  bytes: number;
}

export class PackBuffers {
  private free: Entry[] = [];
  private readonly sizes = new Map<WebGLBuffer, number>();
  /** Buffers handed out when dispose() ran; deleted on release, so an in-flight readback never reads a deleted buffer. */
  private readonly orphans = new Set<WebGLBuffer>();

  constructor(private readonly gl: GL) {}

  acquire(bytes: number): WebGLBuffer {
    const { gl } = this;
    const i = this.free.findIndex((e) => e.bytes >= bytes);
    let entry: Entry;
    if (i >= 0) {
      entry = this.free.splice(i, 1)[0];
      // Re-specify (orphan) the storage before it is written again. Chrome keeps a shadow copy of
      // every fenced READ buffer to speed up getBufferSubData; writing a buffer that has one, even
      // after it was read, logs "READ-usage buffer was written, then fenced, but written again
      // before being read back" once per readback, and after ~32 such warnings the context stops
      // reporting WebGL errors at all. New storage drops the old shadow silently, at the same cost.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, entry.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, entry.bytes, gl.STREAM_READ);
    } else {
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error('Could not create a pixel buffer (is the WebGL context lost?)');
      entry = { buffer, bytes };
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      this.sizes.set(buffer, bytes);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, entry.buffer);
    return entry.buffer;
  }

  release(buffer: WebGLBuffer): void {
    if (this.orphans.delete(buffer)) {
      this.gl.deleteBuffer(buffer);
      return;
    }
    const bytes = this.sizes.get(buffer);
    if (bytes === undefined) return;
    if (bytes > KEEP_BYTES || this.free.length >= KEEP_COUNT) {
      this.sizes.delete(buffer);
      this.gl.deleteBuffer(buffer);
      return;
    }
    this.free.push({ buffer, bytes });
  }

  /** Frees the pooled buffers now and the ones still in use when they are released. */
  dispose(): void {
    const free = new Set(this.free.map((e) => e.buffer));
    for (const buffer of this.sizes.keys()) {
      if (free.has(buffer)) this.gl.deleteBuffer(buffer);
      else this.orphans.add(buffer);
    }
    this.sizes.clear();
    this.free = [];
  }
}

export async function fenceAndWait(gl: GL): Promise<void> {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) throw new Error('The WebGL context was lost during a readback.');
  gl.flush();
  try {
    for (;;) {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
      if (status === gl.WAIT_FAILED || gl.isContextLost()) throw new Error('The WebGL context was lost during a readback.');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    gl.deleteSync(sync);
  }
}
