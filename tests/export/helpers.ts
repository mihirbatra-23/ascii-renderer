import { DEFAULT_PARAMS, type CellGeometry, type GridSnapshot, type RenderParams } from '../../src/engine/types';

export const GEOMETRY: CellGeometry = {
  cellW: 8,
  cellH: 16,
  fontSize: 8 / 0.6,
  baseline: 12,
  fontFamily: '"JetBrains Mono", monospace',
  advanceEm: 0.6,
};

export interface SnapshotSpec {
  rows: string[];
  params?: Partial<RenderParams>;
  geometry?: Partial<CellGeometry>;
  /** Per-cell colour (row-major) as 0xRRGGBB; defaults to mid grey. */
  colors?: number[];
  backgrounds?: number[];
  tone?: number[];
}

/** Builds a GridSnapshot from rows of text (one code point per cell). */
export function makeSnapshot(spec: SnapshotSpec): GridSnapshot {
  const grid = spec.rows.map((row) => [...row]);
  const cols = grid[0].length;
  const rows = grid.length;
  if (grid.some((r) => r.length !== cols)) throw new Error('ragged rows');
  const n = cols * rows;
  const toBytes = (list: number[]) => {
    const out = new Uint8Array(n * 3);
    list.forEach((c, i) => out.set([(c >> 16) & 255, (c >> 8) & 255, c & 255], i * 3));
    return out;
  };
  return {
    cols,
    rows,
    chars: grid.flat(),
    colors: toBytes(spec.colors ?? new Array<number>(n).fill(0x808080)),
    backgrounds: spec.backgrounds ? toBytes(spec.backgrounds) : undefined,
    tone: Float32Array.from(spec.tone ?? new Array<number>(n).fill(0.5)),
    geometry: { ...GEOMETRY, ...spec.geometry },
    params: { ...DEFAULT_PARAMS, ...spec.params },
  };
}

/**
 * Minimal XML well-formedness check (enough for generated SVG): balanced tags, quoted attributes,
 * no duplicate attributes, only known entities, no stray '<' or '&'.
 */
export function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  const token = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let roots = 0;
  for (const m of xml.matchAll(token)) {
    const [, close, open, attrs, selfClose, text, stray] = m;
    if (stray) throw new Error(`stray "<" at ${m.index}: ${xml.slice(m.index, m.index + 40)}`);
    if (text !== undefined) {
      const bad = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.exec(text);
      if (bad) throw new Error(`bad entity at ${m.index}`);
      if (stack.length === 0 && text.trim()) throw new Error('text outside root');
      continue;
    }
    if (close) {
      const top = stack.pop();
      if (top !== close) throw new Error(`</${close}> closes <${top}>`);
      continue;
    }
    if (open) {
      const names = [...(attrs ?? '').matchAll(/([\w:.-]+)\s*=/g)].map((a) => a[1]);
      if (new Set(names).size !== names.length) throw new Error(`duplicate attribute on <${open}>`);
      if (stack.length === 0) roots++;
      if (!selfClose) stack.push(open);
    }
  }
  if (stack.length) throw new Error(`unclosed <${stack.join('> <')}>`);
  if (roots !== 1) throw new Error(`expected one root element, got ${roots}`);
}

/** Absolute points of an SVG path that uses M/m/l/q/c/z (with implicit repeats), in order. */
export function absolutePathPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MmLlQqCcZz]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const pts: Array<[number, number]> = [];
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const arity: Record<string, number> = { m: 2, l: 2, q: 4, c: 6 };
  let t = 0;
  while (t < tokens.length) {
    if (/[A-Za-z]/.test(tokens[t])) {
      cmd = tokens[t++];
      if (cmd === 'z' || cmd === 'Z') {
        x = sx;
        y = sy;
        continue;
      }
    } else if (cmd === 'm') cmd = 'l';
    else if (cmd === 'M') cmd = 'L';
    const rel = cmd === cmd.toLowerCase();
    const n = arity[cmd.toLowerCase()];
    const nums = tokens.slice(t, t + n).map(Number);
    t += n;
    let ex = x;
    let ey = y;
    for (let k = 0; k < n; k += 2) {
      const px = rel ? x + nums[k] : nums[k];
      const py = rel ? y + nums[k + 1] : nums[k + 1];
      pts.push([px, py]);
      ex = px;
      ey = py;
    }
    x = ex;
    y = ey;
    if (cmd.toLowerCase() === 'm') {
      sx = x;
      sy = y;
    }
  }
  return pts;
}
