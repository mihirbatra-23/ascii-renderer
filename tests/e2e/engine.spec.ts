/**
 * The WebGL2 engine (src/engine/gl) in real Chrome, driven through dev/engine.html:
 *   - GPU grid = CPU reference glyph for glyph when the CPU is fed the GPU's analysis image
 *     (≥ 99.9 %), and the end-to-end mismatch from the source pixels (target ≤ 1 %)
 *   - exact raster sizes for scales 1/2/4 (± margin), clear error above the device limit
 *   - preview = export at integer zoom, context loss / restore, CPU fallback
 *   - GPU-synchronised timings (200 × 110 cells) and real-time 720p playback (corpus, optional)
 *   - PNG renders of every mode for eyeballing when ENGINE_GPU_SHOTS is set
 * Pure view-layout maths is checked here in Node too.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { layoutView } from '../../src/engine/gl/view';
import { affectsAnalysis, glyphKey } from '../../src/engine/gl/params';
import { DEFAULT_PARAMS, type RenderParams } from '../../src/engine/types';

const SHOTS = process.env.ENGINE_GPU_SHOTS;
const CORPUS = process.env.ENGINE_GPU_CORPUS;

async function openHarness(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/dev/engine.html');
  await page.evaluate(() => window.engineHarness.ready);
  return errors;
}

test('smoke: harness renders every mode without GL errors', async ({ page }) => {
  const errors = await openHarness(page);
  const info = await page.evaluate(() => window.engineHarness.gpuInfo());
  console.log('GPU', JSON.stringify(info));
  for (const mode of ['shape', 'ramp', 'braille', 'blocks', 'halftone'] as const) {
    const stats = await page.evaluate(async (m) => {
      await window.engineHarness.setParams({ mode: m });
      return window.engineHarness.render();
    }, mode);
    expect(stats.cols, mode).toBe(160);
  }
  expect(errors).toEqual([]);
});

test('view layout (pure)', () => {
  const vp = { width: 800, height: 600, devicePixelRatio: 2, zoom: 'fit' as const, panX: 0, panY: 0, compare: null, showSource: false };
  const fit = layoutView(vp, 1280, 640);
  expect(fit.width).toBe(1600);
  expect(fit.height).toBe(1200);
  // (1600 − 64) / 1280 = 1.2 is more than 10 % above 1, so the fit stays fractional and centred.
  expect(fit.zoom).toBeCloseTo(1.2, 10);
  expect(fit.exact).toBe(false);
  expect(fit.originX).toBeCloseTo((1600 - 1280 * 1.2) / 2, 10);
  // Within 10 % of a whole zoom, 'fit' snaps down to it and lands on whole pixels.
  const snapped = layoutView({ ...vp, width: 1360 / 2 + 32 }, 1280, 640);
  expect(snapped.zoom).toBe(1);
  expect(snapped.exact).toBe(true);
  expect(Number.isInteger(snapped.originX) && Number.isInteger(snapped.originY)).toBe(true);
  const zoomed = layoutView({ ...vp, zoom: 1.5, panX: 10.3, panY: -4 }, 1280, 640);
  expect(zoomed.zoom).toBe(3);
  expect(zoomed.exact).toBe(true);
  expect(zoomed.originX).toBe(Math.round((1600 - 3840) / 2 + 20.6));
  expect(layoutView({ ...vp, compare: 0.25 }, 1280, 640).split).toBe(400);
  expect(layoutView({ ...vp, compare: 0.25, showSource: true }, 1280, 640).split).toBe(Infinity);
});

test('param routing (pure)', () => {
  const p: RenderParams = { ...DEFAULT_PARAMS };
  expect(glyphKey(p)).toBe(glyphKey({ ...p, mode: 'ramp' } as RenderParams));
  expect(glyphKey(p)).not.toBe(glyphKey({ ...p, lineHeight: 1 }));
  expect(glyphKey(p)).toBe(glyphKey({ ...p, customCharset: 'abc' }));
  expect(glyphKey({ ...p, charsetPreset: 'custom', customCharset: 'a' })).not.toBe(glyphKey({ ...p, charsetPreset: 'custom', customCharset: 'b' }));
  expect(affectsAnalysis(p, { ...p, halftoneAngle: 10, shadowInk: '#000000', halftoneShape: 'line' })).toBe(false);
  expect(affectsAnalysis(p, { ...p, colorMode: 'source' })).toBe(false);
  expect(affectsAnalysis({ ...p, mode: 'blocks' }, { ...p, mode: 'blocks', colorMode: 'source' })).toBe(true);
  expect(affectsAnalysis(p, { ...p, gamma: 1.2 })).toBe(true);
});

const SHOT_VARIANTS: { name: string; params: Partial<RenderParams> }[] = [
  { name: 'shape', params: { mode: 'shape' } },
  { name: 'shape-source', params: { mode: 'shape', colorMode: 'source' } },
  { name: 'ramp', params: { mode: 'ramp' } },
  { name: 'braille', params: { mode: 'braille' } },
  { name: 'braille-noise', params: { mode: 'braille', ditherPattern: 'noise' } },
  { name: 'blocks', params: { mode: 'blocks' } },
  { name: 'blocks-source', params: { mode: 'blocks', colorMode: 'source' } },
  { name: 'halftone', params: { mode: 'halftone' } },
  { name: 'halftone-duotone-square', params: { mode: 'halftone', colorMode: 'duotone', halftoneShape: 'square' } },
  { name: 'shape-lh1-light', params: { mode: 'shape', lineHeight: 1, ink: '#111111', paper: '#f4f1ea' } },
];

test('renders of every mode (ENGINE_GPU_SHOTS)', async ({ page }) => {
  test.skip(!SHOTS, 'set ENGINE_GPU_SHOTS to a directory to write PNGs');
  const dir = SHOTS!;
  mkdirSync(dir, { recursive: true });
  const errors = await openHarness(page);
  const save = (name: string, b64: string) => writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
  for (const fixture of ['torus_450.png', 'terrain_640x360.png']) {
    await page.evaluate((f) => window.engineHarness.loadFixture(f), fixture);
    const stem = fixture.replace(/\.\w+$/, '');
    for (const v of SHOT_VARIANTS) {
      const b64 = await page.evaluate(async (params) => {
        await window.engineHarness.setParams({ ...params });
        return window.engineHarness.exportPng(2);
      }, { ...DEFAULT_PARAMS, ...v.params });
      save(`${stem}-${v.name}-x2.png`, b64);
    }
    await page.evaluate((p) => window.engineHarness.setParams(p), { ...DEFAULT_PARAMS });
    save(`${stem}-preview-fit.png`, await page.evaluate(() => window.engineHarness.previewPng({ zoom: 'fit' })));
    save(`${stem}-preview-zoom1.25.png`, await page.evaluate(() => window.engineHarness.previewPng({ zoom: 1.25, devicePixelRatio: 1 })));
    save(`${stem}-preview-compare.png`, await page.evaluate(() => window.engineHarness.previewPng({ zoom: 'fit', compare: 0.4 })));
    save(`${stem}-export-x1.png`, await page.evaluate(() => window.engineHarness.exportPng(1)));
  }
  expect(errors).toEqual([]);
});

const GATE_FIXTURES = ['torus_450.png', 'terrain_640x360.png', 'waves_600x400.png', 'lineart_600x300.png', 'gradient_512x64.png', 'logo_rgba_256.png'];
const GATE_VARIANTS: { name: string; params: Partial<RenderParams> }[] = [
  { name: 'shape', params: { mode: 'shape' } },
  { name: 'shape lh1.0 geist', params: { mode: 'shape', lineHeight: 1, font: 'geist-mono' } },
  { name: 'shape lh1.5 plex dense', params: { mode: 'shape', lineHeight: 1.5, font: 'ibm-plex-mono', charsetPreset: 'dense' } },
  { name: 'shape tone+light paper', params: { mode: 'shape', gamma: 0.7, contrast: 1.4, brightness: 0.05, ink: '#111111', paper: '#f4f1ea', shapeSharpness: 2.2, edgeSharpness: 1.2, dither: 0.25 } },
  { name: 'ramp', params: { mode: 'ramp' } },
  { name: 'ramp minimal', params: { mode: 'ramp', charsetPreset: 'minimal', dither: 0.3, invert: true } },
  { name: 'braille ordered', params: { mode: 'braille' } },
  { name: 'braille noise lh1.0', params: { mode: 'braille', ditherPattern: 'noise', lineHeight: 1 } },
  { name: 'braille none', params: { mode: 'braille', ditherPattern: 'none' } },
  { name: 'blocks ordered', params: { mode: 'blocks' } },
  { name: 'blocks source', params: { mode: 'blocks', colorMode: 'source' } },
  { name: 'halftone', params: { mode: 'halftone' } },
  { name: 'shape edges', params: { mode: 'shape', edges: true } },
  { name: 'ramp edges lh1.0 minimal', params: { mode: 'ramp', edges: true, edgeThreshold: 0.3, lineHeight: 1, charsetPreset: 'minimal' } },
  { name: 'shape edges lines lh1.5', params: { mode: 'shape', edges: true, edgeThreshold: 0.7, charsetPreset: 'lines', lineHeight: 1.5 } },
];

test('GPU grid = CPU reference (fixtures × modes)', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openHarness(page);
  // Pass 2 on the programs specialised for each geometry, then a subset on the uniform-driven ones.
  const specialised = await page.evaluate(
    ({ fixtures, variants }) => window.engineHarness.compareAll(fixtures, variants, true),
    { fixtures: GATE_FIXTURES, variants: GATE_VARIANTS },
  );
  const generic = await page.evaluate(
    ({ fixtures, variants }) => window.engineHarness.compareAll(fixtures, variants, false),
    { fixtures: ['terrain_640x360.png', 'lineart_600x300.png', 'logo_rgba_256.png'], variants: GATE_VARIANTS },
  );
  const rows = [...specialised, ...generic.map((r) => ({ ...r, variant: `${r.variant} (uniform)` }))];
  const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(3)}%`;
  console.log('fixture                variant                   grid     fed  (ties)  maxGap     e2e     maxΔL     maxΔtone  maxΔrgb  rgb±1');
  let fedTotal = 0;
  let e2eTotal = 0;
  let cells = 0;
  for (const r of rows) {
    fedTotal += r.fedMismatch;
    e2eTotal += r.e2eMismatch;
    cells += r.cells;
    console.log(
      [
        r.fixture.padEnd(22),
        r.variant.padEnd(35),
        `${r.cols}x${r.rows}`.padEnd(8),
        String(r.fedMismatch).padStart(4),
        `(${r.fedNearTies})`.padStart(7),
        r.fedMaxGap.toExponential(1).padStart(8),
        pct(r.e2eMismatch, r.cells).padStart(8),
        `(${r.e2eNearTies} ties, gap ${r.e2eMaxGap.toExponential(1)})`.padStart(22),
        r.maxLightnessDiff.toExponential(1).padStart(9),
        r.maxToneDiff.toExponential(1).padStart(9),
        String(r.maxColourDiff).padStart(7),
        (100 * r.colourWithin1).toFixed(2).padStart(7),
      ].join(' '),
    );
  }
  console.log(`TOTAL fed agreement ${pct(cells - fedTotal, cells)} (${fedTotal} of ${cells} cells differ); end-to-end mismatch ${pct(e2eTotal, cells)}`);
  // Blocks' two-colour fit has exact ties in its own arithmetic (symmetric quadrant values in
  // smooth gradients); the CPU breaks them by float noise, the GPU by the lowest mask. Those
  // cells are listed as ties; everything else must agree.
  const fedAgreement = (cells - fedTotal) / cells;
  expect(fedAgreement, 'fed agreement over every fixture × variant').toBeGreaterThanOrEqual(0.999);
  for (const r of rows) {
    const label = `${r.fixture} ${r.variant}`;
    if (!r.variant.startsWith('blocks source')) expect(r.fedMismatch / r.cells, `${label}: fed agreement`).toBeLessThanOrEqual(0.001);
    expect((r.fedMismatch - r.fedNearTies) / r.cells, `${label}: fed mismatches that are not ties`).toBeLessThanOrEqual(0.001);
    expect((r.e2eMismatch - r.e2eNearTies) / r.cells, `${label}: end-to-end mismatches that are not ties`).toBeLessThanOrEqual(0.01);
  }
  expect(errors).toEqual([]);
});

test('§8 temporal stability: GPU history = CPU history over a clip', async ({ page }) => {
  const errors = await openHarness(page);
  await page.evaluate(() => window.engineHarness.loadFixture('terrain_640x360.png'));
  for (const variant of [
    { mode: 'shape', stability: 0.5 },
    { mode: 'shape', stability: 1 },
    { mode: 'ramp', stability: 0.7 },
    { mode: 'braille', stability: 0.5 },
    { mode: 'blocks', stability: 0.5 },
    { mode: 'halftone', stability: 0.5 },
    { mode: 'braille', ditherPattern: 'noise', stability: 1 },
    { mode: 'blocks', colorMode: 'source', stability: 0.5 },
    { mode: 'shape', edges: true, stability: 0.5 },
    { mode: 'ramp', edges: true, edgeThreshold: 0.3, stability: 1 },
  ] as Partial<RenderParams>[]) {
    for (const specialised of [true, false]) {
      const frames = await page.evaluate(({ v, s }) => window.engineHarness.historyCheck(12, v, s), { v: variant, s: specialised });
      const total = frames.reduce((a, f) => a + f.mismatch, 0);
      const cells = frames.reduce((a, f) => a + f.cells, 0);
      const label = `${JSON.stringify(variant)}${specialised ? '' : ' (uniform)'}`;
      console.log(`history ${label}: ${total} of ${cells} cells differ over ${frames.length} frames [${frames.map((f) => f.mismatch).join(' ')}]`);
      expect(total / cells, `${label}: GPU vs CPU with history`).toBeLessThanOrEqual(0.001);
    }
  }
  expect(errors).toEqual([]);
});

test('exact raster sizes, oversize error, preview = export', async ({ page }) => {
  const errors = await openHarness(page);
  for (const fixture of ['torus_450.png', 'exif6_480x270.jpg', 'gray16_200.png']) {
    for (const variant of [{ mode: 'shape' }, { mode: 'blocks', colorMode: 'source', lineHeight: 1 }, { mode: 'halftone', lineHeight: 1.5 }] as Partial<RenderParams>[]) {
      const checks = await page.evaluate(async ({ f, v }) => {
        await window.engineHarness.loadFixture(f);
        await window.engineHarness.setParams(v);
        return window.engineHarness.rasterChecks();
      }, { f: fixture, v: { ...DEFAULT_PARAMS, ...variant } });
      for (const c of checks) {
        expect([c.width, c.height], `${fixture} ${variant.mode} ×${c.scale} margin ${c.margin}`).toEqual([c.expectedWidth, c.expectedHeight]);
      }
    }
  }
  // EXIF orientation 6: the 480 × 270 file displays as 270 × 480, so the grid must be portrait.
  const portrait = await page.evaluate(async () => {
    await window.engineHarness.loadFixture('exif6_480x270.jpg');
    await window.engineHarness.setParams({ mode: 'shape', lineHeight: 1.2 });
    return window.engineHarness.render();
  });
  expect(portrait.rows).toBeGreaterThan(portrait.cols / 2);

  const oversize = await page.evaluate(() => window.engineHarness.oversizedRasterError());
  expect(oversize).toMatch(/larger than this device can render/);

  await page.evaluate(() => window.engineHarness.loadFixture('torus_450.png'));
  for (const mode of ['shape', 'braille', 'blocks', 'halftone'] as const) {
    for (const [z, transparent] of [[1, false], [2, false], [1, true]] as const) {
      const r = await page.evaluate(async ({ m, z, t }) => {
        await window.engineHarness.setParams({ mode: m, colorMode: m === 'blocks' ? 'source' : 'mono', lineHeight: 1 });
        return window.engineHarness.previewVsExport(z, t);
      }, { m: mode, z, t: transparent });
      const label = `${mode} zoom ${z}${transparent ? ' transparent' : ''}`;
      expect(r.exact, label).toBe(true);
      expect(r.differing, `${label}: preview pixels ≠ export pixels`).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});

test('readRaster = renderRaster, asynchronously; it never returns a picture that changed mid-read', async ({ page }) => {
  const errors = await openHarness(page);
  for (const variant of [{ mode: 'shape' }, { mode: 'halftone', colorMode: 'duotone' }, { mode: 'blocks', colorMode: 'source', lineHeight: 1 }] as Partial<RenderParams>[]) {
    const rows = await page.evaluate(async (v) => {
      await window.engineHarness.loadFixture('terrain_640x360.png');
      await window.engineHarness.setParams(v);
      return window.engineHarness.readRasterCheck([
        { scale: 1, margin: 0, transparent: false },
        { scale: 2, margin: 3, transparent: true },
        { scale: 4, margin: 0, transparent: false },
      ]);
    }, { ...DEFAULT_PARAMS, ...variant });
    for (const r of rows) {
      expect([r.width, r.height], `${variant.mode} ×${r.scale}`).toEqual(r.expected);
      expect(r.differing, `${variant.mode} ×${r.scale}: readRaster pixels ≠ renderRaster pixels`).toBe(0);
    }
  }
  // 400 columns at ×2 is 6400 × 6400 px (164 MB), read in batches: every batch comes from the picture
  // at the call, whatever changes in between (an edit no longer fails a large export; // closing the file no longer leaves blank bands or reads a deleted buffer).
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && /WebGL|deleted|no buffer/i.test(m.text())) warnings.push(m.text());
  });
  const changed = await page.evaluate(async () => {
    await window.engineHarness.loadFixture('torus_450.png');
    await window.engineHarness.setParams({ columns: 400, mode: 'shape' });
    return window.engineHarness.readRasterChangeCheck(2);
  });
  expect(changed.find((c) => c.change === 'params')).toEqual({ change: 'params', differing: 0, notOpaque: 0, error: null });
  expect(changed.find((c) => c.change === 'releaseSource')).toEqual({ change: 'releaseSource', differing: 0, notOpaque: 0, error: null });
  expect(changed.find((c) => c.change === 'lineHeight')?.error).toMatch(/changed while the picture was being exported/);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});

test('probe answers from an async readback; GPU timings; warmup compiles every program', async ({ page }) => {
  const errors = await openHarness(page);
  await page.evaluate(() => window.engineHarness.loadFixture('torus_450.png'));
  const probe = await page.evaluate(() => window.engineHarness.probeCheck());
  console.log('probe', JSON.stringify(probe));
  expect(probe.frames).toBeLessThan(60);
  expect(probe.matches).toBe(probe.checked);
  expect(probe.outside).toBeNull();

  const timings = await page.evaluate(() => window.engineHarness.timingsCheck());
  console.log('timings', JSON.stringify(timings));
  expect(timings.cpuMs).toBeGreaterThanOrEqual(0);
  if (timings.timerQuery) {
    expect(timings.gpuMs).not.toBeNull();
    expect(timings.gpuMs!).toBeGreaterThan(0);
  } else {
    expect(timings.gpuMs).toBeNull();
  }

  const warm = await page.evaluate(() => window.engineHarness.warmupCheck());
  console.log('warmup', JSON.stringify(warm));
  for (const key of ['lightness', 'quadrants', 'cell:shape', 'cell:ramp', 'cell:braille', 'cell:blocks', 'cell:halftone', 'compose:text', 'compose:braille', 'compose:blocks', 'compose:halftone', 'present', 'edge-blur', 'edge-dog']) {
    expect(warm.compiledAfterWarmup, key).toContain(key);
  }
  // Renders may start the geometry-specialised pass 2 in the background, but never compile anything else.
  expect(warm.newAfterRenders.filter((k) => !/^cell:\w+:\d+x\d+$/.test(k))).toEqual([]);
  expect(errors).toEqual([]);
});

test('releaseSource frees source- and grid-sized GPU memory; compare with ramp; minified preview', async ({ page }) => {
  const errors = await openHarness(page);
  await page.evaluate(() => window.engineHarness.loadFixture('terrain_640x360.png'));
  const release = await page.evaluate(() => window.engineHarness.releaseCheck());
  console.log('release', JSON.stringify(release));
  expect(release.before).toMatchObject({ analysis: true, edges: true, cells: true, compare: true, preview: true });
  expect(release.after).toEqual({ source: [0, 0], analysis: false, edges: false, cells: false, compare: false, preview: false, exportTile: false });
  expect(release.gridAfter).toMatchObject({ cols: 0, rows: 0 });
  expect(release.restoredEqual).toBe(true);

  for (const mode of ['shape', 'braille', 'halftone'] as const) {
    const cmp = await page.evaluate(async (m) => {
      await window.engineHarness.setParams({ mode: m, lineHeight: 1.2 });
      return window.engineHarness.compareRampCheck();
    }, mode);
    expect(cmp.leftDiffering, `${mode}: left of the split = the ramp render`).toBe(0);
    expect(cmp.rightDiffering, `${mode}: right of the split = the render`).toBe(0);
  }

  for (const mode of ['shape', 'halftone', 'braille', 'blocks'] as const) {
    const m = await page.evaluate(async (md) => {
      await window.engineHarness.setParams({ mode: md, colorMode: 'mono' });
      return window.engineHarness.minifiedCheck();
    }, mode);
    console.log(`minified ${mode}`, JSON.stringify(m));
    expect(m.zoom).toBe(0.5);
    expect(m.maxDiff, `${mode}: preview at 0.5 = 2 × 2 box filter of the 1× export`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('context loss and restore; CPU fallback engine', async ({ page }) => {
  const errors = await openHarness(page);
  await page.evaluate(() => window.engineHarness.loadFixture('terrain_640x360.png'));
  const loss = await page.evaluate(() => window.engineHarness.contextLossCheck());
  console.log('context loss', JSON.stringify(loss));
  expect(loss.renderedWhileLost).toBe(true);
  expect(loss.snapshotWhileLost).toMatch(/context was lost/);
  expect(loss.restoredEqual).toBe(true);

  for (const variant of [{ mode: 'shape' }, { mode: 'braille' }, { mode: 'halftone', colorMode: 'duotone' }] as Partial<RenderParams>[]) {
    const cpu = await page.evaluate(async (v) => {
      await window.engineHarness.setParams(v);
      return window.engineHarness.cpuFallbackCheck();
    }, { ...DEFAULT_PARAMS, ...variant });
    console.log('cpu fallback', variant.mode, JSON.stringify(cpu));
    expect(cpu.sizes).toEqual(cpu.expected);
    expect(cpu.mismatchVsGpu / cpu.cells, `${variant.mode}: CPU fallback vs GPU`).toBeLessThanOrEqual(0.001);
  }

  // a source above the CPU's 4096 px analysis cap keeps the full-size grid (one row was lost).
  const grids = await page.evaluate(() => window.engineHarness.cpuGridCheck(6000, 4000, 262, { font: 'geist-mono', lineHeight: 1 }));
  console.log('cpu grid', JSON.stringify(grids));
  expect(grids.cpu).toEqual(grids.gpu);
  expect(grids.cpuRaster).toEqual(grids.gpuRaster);
  expect(errors).toEqual([]);
});

test('performance: 200 × 110 cells, every mode (GPU-synchronised)', async ({ page }) => {
  const errors = await openHarness(page);
  const info = await page.evaluate(() => window.engineHarness.gpuInfo());
  console.log(`perf on ${info.renderer}`);
  await page.evaluate(async () => {
    await window.engineHarness.loadPerfSource();
    await window.engineHarness.setParams({ columns: 200 });
    // The steady state: pass 2 specialised for this geometry (the app warms up at startup; after a
    // font or line-height change the uniform-driven programs bridge the background compile).
    await window.engineHarness.engine.warmup();
  });
  const viewports = [
    { width: 1440, height: 900, devicePixelRatio: 2, zoom: 'fit' as const },
    { width: 1440, height: 900, devicePixelRatio: 2, zoom: 1.37 },
  ];
  // Cold: straight after load, GPU at idle clocks. Warm: after 1 s of back-to-back frames, as in playback.
  for (const [label, warmupMs, vp] of [['cold', 0, viewports[0]], ['warm', 1000, viewports[0]], ['warm', 1000, viewports[1]]] as const) {
    const rows = await page.evaluate(
      ({ v, w }) => window.engineHarness.profileModes(['shape', 'ramp', 'braille', 'blocks', 'halftone'], 30, { panX: 0, panY: 0, compare: null, showSource: false, ...v }, w),
      { v: vp, w: warmupMs },
    );
    for (const r of rows) {
      console.log(
        `perf ${label} | ${r.mode.padEnd(8)} ${r.cols}x${r.rows} canvas ${r.canvas.join('x')} zoom ${String(vp.zoom).padEnd(4)}: ` +
          `analysis ${r.analysisMs.toFixed(2)} ms + compose ${r.composeMs.toFixed(2)} ms = ${r.totalMs.toFixed(2)} ms (p95 ${r.p95TotalMs.toFixed(2)})`,
      );
      expect(r.cols * 1000 + r.rows).toBe(200 * 1000 + 110);
      if (!/swiftshader/i.test(info.renderer)) expect(r.totalMs, `${r.mode}: analysis + compose`).toBeLessThanOrEqual(8);
    }
  }
  // For information: the largest grid this source allows (400 columns).
  const big = await page.evaluate(async (v) => {
    await window.engineHarness.setParams({ columns: 400 });
    return window.engineHarness.profileModes(['shape', 'braille', 'halftone'], 20, { panX: 0, panY: 0, compare: null, showSource: false, ...v }, 1000);
  }, viewports[0]);
  for (const r of big) {
    console.log(`perf warm | ${r.mode.padEnd(8)} ${r.cols}x${r.rows} canvas ${r.canvas.join('x')} zoom fit : analysis ${r.analysisMs.toFixed(2)} ms + compose ${r.composeMs.toFixed(2)} ms = ${r.totalMs.toFixed(2)} ms`);
  }
  expect(errors).toEqual([]);
});

test('real-time playback of the 720p corpus clip (ENGINE_GPU_CORPUS)', async ({ page }) => {
  const clip = CORPUS ? join(CORPUS, 'videos', 'golden_gate_6s_720p.mp4') : '';
  test.skip(!clip || !existsSync(clip), 'set ENGINE_GPU_CORPUS to the local corpus directory');
  const errors = await openHarness(page);
  await page.setInputFiles('#file', clip);
  const report = await page.evaluate(() => window.engineHarness.playbackCheck(5));
  console.log('playback', JSON.stringify(report));
  expect(report.width).toBeGreaterThanOrEqual(1280);
  expect(report.fps).toBeGreaterThanOrEqual(Math.min(30, report.videoFps * 0.95));
  expect(report.renderedFrames).toBeGreaterThanOrEqual(report.videoFrames - 2);
  expect(report.rafFps).toBeGreaterThanOrEqual(30);
  expect(errors).toEqual([]);
});

test('local corpus: extreme sizes, EXIF, alpha, portrait / HEVC / WebM video (ENGINE_GPU_CORPUS)', async ({ page }) => {
  test.skip(!CORPUS || !existsSync(CORPUS), 'set ENGINE_GPU_CORPUS to the local corpus directory');
  test.setTimeout(300_000);
  const errors = await openHarness(page);
  const files = [
    ['images/aerial_4096x2160.jpg', 160],
    ['images/aerial_4096x2160.jpg', 40],
    ['images/tall_300x3000.jpg', 160],
    ['images/panorama_3000x300.jpg', 400],
    ['images/exif_orientation6_1200x633.jpg', 160],
    ['images/rgba_logo_transparent_800.png', 120],
    ['images/cmyk_640.jpg', 160],
    ['images/tiny_16x16.png', 20],
    ['images/gray16_640x400.png', 160],
    ['videos/siri_portrait_8s.mp4', 120],
    ['videos/reframe_portrait_4s.webm', 120],
    ['videos/reframe_hevc_original.m4v', 160],
    ['videos/sonoma_graphic_5s_1080p.mp4', 200],
  ] as const;
  for (const [file, columns] of files) {
    await page.setInputFiles('#file', join(CORPUS!, file));
    const loaded = await page.evaluate(async (c) => {
      const info = await window.engineHarness.loadChosenFile();
      await window.engineHarness.setParams({ columns: c, mode: 'shape' });
      return { ...info, ...window.engineHarness.sourceInfo() };
    }, columns);
    const geometry = { cellW: 8, cellH: 16 };
    const expectedRows = (loaded.cols * loaded.height * geometry.cellW) / (loaded.width * geometry.cellH);
    const report = await page.evaluate(() => window.engineHarness.compare('corpus'));
    const shot = SHOTS ? await page.evaluate(() => window.engineHarness.exportPng(1)) : null;
    if (shot) writeFileSync(join(SHOTS!, `corpus-${file.replace(/\W+/g, '_')}-${columns}.png`), Buffer.from(shot, 'base64'));
    console.log(
      `corpus ${file.padEnd(40)} ${loaded.width}x${loaded.height} → ${loaded.cols}x${loaded.rows} cells; ` +
        `fed mismatch ${report.fedMismatch}, end-to-end ${((100 * report.e2eMismatch) / report.cells).toFixed(3)}%, max ΔL ${report.maxLightnessDiff.toExponential(1)}`,
    );
    expect(Math.abs(loaded.rows - expectedRows), `${file}: aspect`).toBeLessThanOrEqual(Math.max(0.5, loaded.rows * 0.01));
    expect(report.fedMismatch / report.cells, `${file}: fed agreement`).toBeLessThanOrEqual(0.001);
  }
  expect(errors).toEqual([]);
});
