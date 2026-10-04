/**
 * Engine factory: the WebGL2 renderer when the browser supports it, else the CPU fallback.
 *
 * Public API
 *   EngineOptions                { backend?: 'auto' | 'webgl2' | 'cpu' }
 *   createEngine(options?)       → Promise<RendererEngine>; check `engine.backend` for the fallback
 *   supportsWebGL2()             whether the WebGL2 renderer can run here
 */
import type { EngineBackend, RendererEngine } from './base';
import { GlEngine } from './renderer';
import { CpuEngine } from './fallback';

export interface EngineOptions {
  /** 'auto' (default) tries WebGL2 and falls back to the CPU; 'webgl2' fails instead of falling back. */
  backend?: 'auto' | EngineBackend;
}

export async function createEngine(options: EngineOptions = {}): Promise<RendererEngine> {
  const backend = options.backend ?? 'auto';
  if (backend !== 'cpu') {
    try {
      return GlEngine.create();
    } catch (e) {
      if (backend === 'webgl2') throw e;
      console.warn(`ASCII engine: using the CPU fallback (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return new CpuEngine();
}

export function supportsWebGL2(): boolean {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}
