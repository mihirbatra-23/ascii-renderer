/**
 * Thin WebGL2 plumbing for the renderer: program compilation with readable errors, cached
 * uniform setters, textures and framebuffers. No engine logic lives here.
 *
 * Public API
 *   GL                                   WebGL2RenderingContext alias
 *   Program                              compiled program + lazily cached uniform locations / blocks
 *   startProgram(gl, vs, fs, label)      → PendingProgram: compile and link issued, nothing queried, so
 *                                          with KHR_parallel_shader_compile the driver works off-thread
 *   programReady(gl, pending, ext)       whether the driver has finished (always true without the extension)
 *   finishProgram(gl, pending)           → Program (throws with the info log and numbered source)
 *   TEX                                  texture format triples used by the engine (R32F, RG32F, RGBA8, …)
 *   createTexture(gl, w, h, format, data?, filter?) → WebGLTexture (2D, clamped)
 *   createFramebuffer(gl, textures)      → WebGLFramebuffer with every texture as a draw buffer
 *   checkRenderTargets(gl, layouts)      throws unless each attachment layout is framebuffer-complete
 */
export type GL = WebGL2RenderingContext;

export interface TextureFormat {
  internalFormat: number;
  format: number;
  type: number;
}

/** WebGL enum values, so formats can be named before a context exists. */
export const TEX = {
  R32F: { internalFormat: 0x822e, format: 0x1903, type: 0x1406 },
  RG32F: { internalFormat: 0x8230, format: 0x8227, type: 0x1406 },
  RGBA32F: { internalFormat: 0x8814, format: 0x1908, type: 0x1406 },
  RGBA8: { internalFormat: 0x8058, format: 0x1908, type: 0x1401 },
} as const satisfies Record<string, TextureFormat>;

export class Program {
  private readonly locations = new Map<string, WebGLUniformLocation | null>();
  private readonly blocks = new Map<string, number>();

  constructor(
    private readonly gl: GL,
    readonly handle: WebGLProgram,
  ) {}

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, l);
    }
    return l;
  }

  int(name: string, v: number | boolean): this {
    this.gl.uniform1i(this.loc(name), Number(v));
    return this;
  }

  float(name: string, v: number): this {
    this.gl.uniform1f(this.loc(name), v);
    return this;
  }

  vec2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }

  vec3(name: string, v: readonly [number, number, number]): this {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
    return this;
  }

  vec4(name: string, v: ArrayLike<number>): this {
    this.gl.uniform4f(this.loc(name), v[0], v[1], v[2], v[3]);
    return this;
  }

  ints(name: string, v: Int32Array): this {
    this.gl.uniform1iv(this.loc(name), v);
    return this;
  }

  ivec2(name: string, x: number, y: number): this {
    this.gl.uniform2i(this.loc(name), x, y);
    return this;
  }

  /** Points uniform block `name` at binding point `binding` and binds `buffer` there. */
  block(name: string, binding: number, buffer: WebGLBuffer): this {
    const { gl } = this;
    let index = this.blocks.get(name);
    if (index === undefined) {
      index = gl.getUniformBlockIndex(this.handle, name);
      this.blocks.set(name, index);
    }
    if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(this.handle, index, binding);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, buffer);
    return this;
  }

  /** Binds `texture` to `unit` (TEXTURE_2D unless `target` says otherwise) and points `name` at it. */
  texture(name: string, unit: number, texture: WebGLTexture, target: number = this.gl.TEXTURE_2D): this {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(target, texture);
    this.gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

function numbered(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
    .join('\n');
}

export interface PendingProgram {
  label: string;
  handle: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  vertex: string;
  fragment: string;
}

export function startProgram(gl: GL, vertex: string, fragment: string, label: string): PendingProgram {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error(`${label}: could not create a shader (is the WebGL context lost?)`);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, vertex);
  const fs = shader(gl.FRAGMENT_SHADER, fragment);
  const handle = gl.createProgram();
  if (!handle) throw new Error(`${label}: could not create a program`);
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);
  return { label, handle, vs, fs, vertex, fragment };
}

/** KHR_parallel_shader_compile's COMPLETION_STATUS_KHR. */
const COMPLETION_STATUS_KHR = 0x91b1;

export function programReady(gl: GL, pending: PendingProgram, parallel: boolean): boolean {
  return !parallel || (gl.getProgramParameter(pending.handle, COMPLETION_STATUS_KHR) as boolean);
}

/** Checks compile and link status (this waits for the driver if it is still compiling). */
export function finishProgram(gl: GL, p: PendingProgram): Program {
  const lost = gl.isContextLost();
  const fail = (message: string): never => {
    gl.deleteProgram(p.handle);
    gl.deleteShader(p.vs);
    gl.deleteShader(p.fs);
    throw new Error(message);
  };
  if (!lost && !gl.getProgramParameter(p.handle, gl.LINK_STATUS)) {
    for (const [shader, source, kind] of [
      [p.vs, p.vertex, 'vertex'],
      [p.fs, p.fragment, 'fragment'],
    ] as const) {
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        fail(`${p.label}: ${kind} shader failed to compile:\n${gl.getShaderInfoLog(shader)}\n${numbered(source)}`);
      }
    }
    fail(`${p.label}: program failed to link:\n${gl.getProgramInfoLog(p.handle)}`);
  }
  gl.detachShader(p.handle, p.vs);
  gl.detachShader(p.handle, p.fs);
  gl.deleteShader(p.vs);
  gl.deleteShader(p.fs);
  return new Program(gl, p.handle);
}

export function createTexture(
  gl: GL,
  width: number,
  height: number,
  format: TextureFormat,
  data: ArrayBufferView | null = null,
  filter: number = gl.NEAREST,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Could not create a WebGL texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, width, height, 0, format.format, format.type, data);
  return texture;
}

/**
 * Leaves the framebuffer bound. Completeness is not checked here: checkFramebufferStatus is a
 * synchronous round trip to the GPU process that waits behind any background shader compile (a
 * line-height drag reallocates targets while the new geometry's program compiles), so the attachment
 * layouts are verified once per context instead (checkRenderTargets).
 */
export function createFramebuffer(gl: GL, textures: readonly WebGLTexture[]): WebGLFramebuffer {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Could not create a WebGL framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  return fbo;
}

/**
 * Throws unless every attachment layout is renderable on this context. Completeness depends only on
 * the formats (all targets are single-level textures), so 1 × 1 stand-ins answer for every size.
 */
export function checkRenderTargets(gl: GL, layouts: readonly (readonly TextureFormat[])[]): void {
  for (const formats of layouts) {
    const textures = formats.map((format) => createTexture(gl, 1, 1, format));
    const fbo = createFramebuffer(gl, textures);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    for (const t of textures) gl.deleteTexture(t);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error(`This GPU cannot render to the engine's targets (framebuffer status 0x${status.toString(16)}).`);
    }
  }
}
