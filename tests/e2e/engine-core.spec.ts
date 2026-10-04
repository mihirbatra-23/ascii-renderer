/**
 * The engine core's CPU reference in real Chrome (dev/engine-core.html): bundled fonts load via
 * FontFace, glyph sets build from the browser's rasteriser (including its font-fallback path for
 * missing glyphs), and the §9 invariants hold there as they do in Node.
 */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { EngineCoreReport } from '../../dev/engine-core';

const SHOTS = process.env.ENGINE_CORE_SHOTS;

test('engine core runs in the browser', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/dev/engine-core.html');
  const report: EngineCoreReport = await page.evaluate(() => window.engineCore);
  console.log(JSON.stringify({ ...report, fonts: report.fonts.map(({ probes: _p, ...f }) => f) }));
  expect(errors).toEqual([]);

  const checksums = report.fonts.map((f) => f.checksum.toFixed(3));
  expect(new Set(checksums).size, 'each font draws its own glyphs').toBe(report.fonts.length);
  for (const f of report.fonts) {
    expect(f.loaded, f.font).toBe(true);
    expect(f.advanceEm, f.font).toBeCloseTo(0.6, 3);
    expect([f.cellW, f.cellH], f.font).toEqual([8, 16]);
    expect(f.glyphs, f.font).toBe(95);
    expect(f.dropped, f.font).toEqual([]);
    expect(f.roundTrip, f.font).toBeGreaterThanOrEqual(0.98);
    const row = (v: number[]) => [v[0] + v[1], v[2] + v[3], v[4] + v[5]];
    expect(row(f.probes['-'])[1]).toBeGreaterThan(0.3);
    expect(row(f.probes['_'])[2]).toBeGreaterThan(0.3);
    expect(row(f.probes['.'])[0]).toBe(0);
  }

  // Chrome draws missing glyphs with fallback fonts; they must still be detected and dropped.
  expect(report.missing.kept).toEqual([' ', 'A', '·']);
  expect([...report.missing.dropped].sort()).toEqual(['中', '😀', '█', '⠿', '░'].sort());

  for (const fx of report.fixtures) {
    expect(fx.deterministic, fx.name).toBe(true);
    expect(fx.topShare, fx.name).toBeLessThanOrEqual(0.4);
    expect(fx.rasterSize, fx.name).toEqual(fx.expectedRasterSize);
  }
  expect(report.perfMs).toBeLessThan(100);

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.locator('#out').screenshot({ path: `${SHOTS}/engine-core-browser.png` });
  }
});
