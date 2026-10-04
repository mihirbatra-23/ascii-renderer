// Visual sanity check, not an assertion suite: renders fixtures through the CPU reference into PNG
// contact sheets (source | render). Runs only when CONTACT_SHEET_DIR is set:
//   CONTACT_SHEET_DIR=/some/dir npx vitest run tests/engine/contact-sheet.test.ts
// Optional: CONTACT_SHEET_IMAGES (comma-separated absolute paths) adds images outside the repo.
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas';
import type { RenderParams } from '../../src/engine/types';
import { analyzeCpu, toSnapshot } from '../../src/engine/cpu';
import { measureLevels } from '../../src/engine/tone';
import { renderRasterCpu } from '../../src/engine/rasterCpu';
import { factory, fixturePath, loadRgba, params, pipeline } from './helpers';

const outDir = process.env.CONTACT_SHEET_DIR;
const extra = (process.env.CONTACT_SHEET_IMAGES ?? '').split(',').filter(Boolean);

const VARIANTS: { label: string; p: Partial<RenderParams> }[] = [
  { label: 'shape', p: {} },
  { label: 'shape-edges', p: { edges: true } },
  { label: 'ramp', p: { mode: 'ramp' } },
  { label: 'braille', p: { mode: 'braille' } },
  { label: 'blocks-source', p: { mode: 'blocks', colorMode: 'source' } },
  { label: 'halftone', p: { mode: 'halftone', columns: 120 } },
];

describe.skipIf(!outDir)('contact sheets', () => {
  it('renders fixtures', async () => {
    mkdirSync(outDir!, { recursive: true });
    const sources = ['torus_450.png', 'terrain_640x360.png', 'waves_600x400.png', 'lineart_600x300.png', 'logo_rgba_256.png', 'gradient_512x64.png'].map(fixturePath);
    for (const path of [...sources, ...extra]) {
      const image = await loadRgba(path);
      const levels = measureLevels(image.rgba, image.width, image.height);
      const panels: Canvas[] = [];
      for (const v of VARIANTS) {
        const p = params({ columns: 120, ...v.p });
        const { geometry, taps, glyphSet } = pipeline(p);
        const t0 = performance.now();
        const result = analyzeCpu(image, p, levels, geometry, glyphSet, taps);
        const ms = performance.now() - t0;
        const snap = toSnapshot(result, glyphSet, p, geometry);
        const { canvas } = renderRasterCpu(snap, { scale: 1, margin: 0, transparentBackground: false }, factory);
        panels.push(canvas as Canvas);
        const counts = new Map<string, number>();
        snap.chars.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
        const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`${basename(path)} ${v.label} ${snap.cols}x${snap.rows} ${ms.toFixed(1)}ms top=${JSON.stringify(top)}`);
        if (v.label === 'shape') writeFileSync(`${outDir}/${basename(path)}.txt`, chunk(snap.chars, snap.cols));
      }
      // Two-column grid: source first, then one panel per variant.
      const w = panels[0].width;
      const h = panels[0].height;
      const cells = panels.length + 1;
      const sheet = createCanvas(w * 2, h * Math.ceil(cells / 2));
      const sctx = sheet.getContext('2d');
      sctx.fillStyle = '#333';
      sctx.fillRect(0, 0, sheet.width, sheet.height);
      const src = createCanvas(image.width, image.height);
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
      const fit = Math.min(w / image.width, h / image.height);
      sctx.drawImage(src, 0, 0, image.width * fit, image.height * fit);
      panels.forEach((c, i) => sctx.drawImage(c, w * ((i + 1) % 2), h * ((i + 1) >> 1), Math.min(w, c.width), Math.min(h, c.height)));
      writeFileSync(`${outDir}/${basename(path)}.png`, sheet.toBuffer('image/png'));
    }
  }, 300_000);
});

function chunk(chars: string[], cols: number): string {
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += cols) lines.push(chars.slice(i, i + cols).join(''));
  return lines.join('\n') + '\n';
}
