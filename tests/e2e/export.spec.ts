import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Exporters in a real browser (dev/export.html, fake engine). Set EXPORT_SAMPLES_DIR to keep the
 * produced files for inspection, and ASCII_CORPUS_DIR (with videos/) to also run the large-media cases.
 */
const SAMPLES = process.env.EXPORT_SAMPLES_DIR;
const CORPUS = process.env.ASCII_CORPUS_DIR;

function save(name: string, base64: string | undefined): void {
  if (!SAMPLES || !base64) return;
  mkdirSync(SAMPLES, { recursive: true });
  writeFileSync(join(SAMPLES, name), Buffer.from(base64, 'base64'));
}

function saveText(name: string, text: string): void {
  if (!SAMPLES) return;
  mkdirSync(SAMPLES, { recursive: true });
  writeFileSync(join(SAMPLES, name), text);
}

async function open(page: Page): Promise<void> {
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto('/dev/export.html');
  await page.waitForFunction(() => !!window.exportHarness);
}

test.describe('export (browser)', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('PNG is exactly (cols·cellW + 2m)·s × (rows·cellH + 2m)·s for scales 1, 2, 4', async ({ page }) => {
    for (const [scale, margin] of [
      [1, 0],
      [2, 0],
      [4, 0],
      [2, 6],
    ]) {
      const r = await page.evaluate(([s, m]) => window.exportHarness.png(s, m), [scale, margin]);
      expect(r.decoded).toEqual(r.expected);
      expect({ width: r.width, height: r.height }).toEqual(r.expected);
      expect(r.warnings).toEqual([]);
      expect(r.fileName).toBe(`synthetic-ascii-${r.grid.cols}x${r.grid.rows}.png`);
      if (scale === 2 && margin === 0) save('synthetic-2x.png', r.base64);
    }
  });

  test('PNG at an exact width: rendered at the next scale, shrunk to exactly that width, aspect kept', async ({ page }) => {
    for (const [width, margin] of [
      [1000, 0],
      [333, 2],
      [1280, 0],
    ]) {
      const r = await page.evaluate(([w, m]) => window.exportHarness.png(1, m, false, w), [width, margin]);
      expect(r.decoded).toEqual(r.expected);
      expect({ width: r.width, height: r.height }).toEqual(r.expected);
      // An area average in linear light keeps the raster's mean light (no darkened strokes) …
      expect(Math.abs(r.resample!.linearMean - r.resample!.sourceLinearMean)).toBeLessThan(0.01);
      // … and the picture lines up with the browser's own downscale of the exact-scale raster.
      const best = Object.entries(r.resample!.alignment).sort((a, b) => b[1] - a[1])[0];
      expect(best[0]).toBe('0,0');
      expect(r.resample!.alignment['0,0']).toBeGreaterThan(0.95);
      if (width === 1000) save('synthetic-1000w.png', r.base64);
    }
  });

  test('PNG larger than the device limit fails with advice', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.pngTooLarge());
    expect(r.code).toBe('too-large');
    expect(r.error).toMatch(/Use 3× or lower/);
  });

  test('GIF: 12 frames decode back with the right count, delays, size, loop and a fixed palette', async ({ page }) => {
    const durations = Array.from({ length: 12 }, (_, i) => (i % 2 ? 120 : 40));
    const r = await page.evaluate((d) => window.exportHarness.gif({ durations: d, colorMode: 'mono' }), durations);
    expect(r.decoded.count).toBe(12);
    expect(r.decoded.delays).toEqual(durations);
    expect({ width: r.decoded.width, height: r.decoded.height }).toEqual({ width: r.width, height: r.height });
    expect(r.width).toBe(60 * 8 + 8);
    expect(r.decoded.loop).toBe(0);
    expect(r.decoded.globalPaletteSize).toBeLessThanOrEqual(32);
    expect(r.decoded.localTables).toBe(0);
    expect(r.progress.at(-1)?.[1]).toMatch(/Finishing|Encoding frame 12 \/ 12/);
    expect(r.resets).toBeGreaterThanOrEqual(2);
    save('synthetic-mono.gif', r.base64);
  });

  test('GIF frames after the first store only what changed, and play back as the rendered frames', async ({ page }) => {
    const durations = new Array(16).fill(60);
    for (const colorMode of ['mono', 'source'] as const) {
      const r = await page.evaluate(([d, c]) => window.exportHarness.gif({ durations: d as number[], colorMode: c as 'mono' | 'source', samples: true }), [
        durations,
        colorMode,
      ] as const);
      const full = { left: 0, top: 0, width: r.width!, height: r.height! };
      expect(r.decoded.rects[0]).toEqual(full);
      expect(r.decoded.transparent[0]).toBe(false);
      expect(r.decoded.transparent.slice(1).every(Boolean)).toBe(true);
      expect(r.decoded.disposal.every((d: number) => d === 1)).toBe(true);
      // The moving ball only touches part of the frame.
      expect(r.decoded.rects.slice(1).some((rect: typeof full) => rect.width * rect.height < full.width * full.height)).toBe(true);
      // Composited frames equal the engine's raster of each frame up to palette rounding.
      expect(r.maxFrameDiff, colorMode).toBeLessThan(colorMode === 'mono' ? 6 : 10);
      expect(r.decoded.globalPaletteSize).toBeLessThanOrEqual(256);
    }
  });

  test('GIF at an exact width (resampled in the worker)', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.gif({ durations: new Array(4).fill(100), targetWidth: 300 }));
    // The fake engine's 1× raster: 60 cols × 8 px and rows × 17 px, plus a 4 px margin.
    const rows = Math.round(((60 * 180) / 320) * (8 / 17));
    const height = Math.round((300 * (rows * 17 + 8)) / (60 * 8 + 8));
    expect({ width: r.width, height: r.height }).toEqual({ width: 300, height });
    expect({ width: r.decoded.width, height: r.decoded.height }).toEqual({ width: 300, height });
    expect(r.decoded.count).toBe(4);
  });

  test('GIF: duotone fixed palette and 30 fps delays carried forward', async ({ page }) => {
    const durations = new Array(30).fill(1000 / 30);
    const r = await page.evaluate((d) => window.exportHarness.gif({ durations: d, colorMode: 'duotone', loopCount: 3 }), durations);
    expect(r.decoded.count).toBe(30);
    expect(r.decoded.delays.reduce((a: number, b: number) => a + b, 0)).toBe(1000);
    expect(new Set(r.decoded.delays)).toEqual(new Set([30, 40]));
    expect(r.decoded.globalPaletteSize).toBeLessThanOrEqual(32);
    expect(r.decoded.loop).toBe(3);
    save('synthetic-duotone.gif', r.base64);
  });

  test('GIF: source colour uses one global palette (buffered samples, explicit samples, samples that yield nothing)', async ({ page }) => {
    const durations = new Array(12).fill(80);
    for (const samples of [false, true, 'none'] as const) {
      const r = await page.evaluate(([d, s]) => window.exportHarness.gif({ durations: d as number[], colorMode: 'source', samples: s as boolean | 'none' }), [
        durations,
        samples,
      ] as const);
      expect(r.decoded.count).toBe(12);
      expect(r.decoded.globalPaletteSize).toBeLessThanOrEqual(256);
      expect(r.decoded.globalPaletteSize).toBeGreaterThan(32);
      expect(r.decoded.localTables).toBe(0);
      expect(r.decoded.delays).toEqual(durations);
      expect(r.maxFrameDiff, `samples: ${samples}`).toBeLessThan(10);
      if (samples === true) save('synthetic-colour.gif', r.base64);
    }
  });

  test('GIF from a GIF keeps every source delay (trimmed) and the loop count', async ({ page }) => {
    const all = await page.evaluate(() =>
      window.exportHarness.gifFromMedia({ url: '/tests/fixtures/transparent_variable_duration.gif', colorMode: 'source' }),
    );
    expect(all.kind).toBe('animation');
    expect(all.decoded.count).toBe(24);
    expect(all.decoded.delays).toEqual(all.expectedDelays.map((d: number) => Math.round(d / 10) * 10));
    expect(all.decoded.loop).toBe(all.sourceLoop);
    save('transparent_variable_duration-ascii.gif', all.base64);

    const trimmed = await page.evaluate(() =>
      window.exportHarness.gifFromMedia({ url: '/tests/fixtures/transparent_variable_duration.gif', startSec: 0.1, endSec: 0.9 }),
    );
    expect(trimmed.decoded.count).toBe(trimmed.expectedDelays.length);
    expect(trimmed.decoded.delays.reduce((a: number, b: number) => a + b, 0)).toBe(800);
  });

  test('GIF from a video samples it at the GIF frame rate', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.exportHarness.gifFromMedia({ url: '/tests/fixtures/testsrc2_4s.mp4', startSec: 1, endSec: 2, fps: 10, colorMode: 'source' }),
    );
    expect(r.kind).toBe('video');
    expect(r.decoded.count).toBe(10);
    expect(r.decoded.delays).toEqual(new Array(10).fill(100));
    save('testsrc2-ascii.gif', r.base64);
  });

  test('GIF from a streaming WebM without cues is complete, not truncated', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.cuelessWebmGif());
    console.log('cue-less WebM', JSON.stringify(r));
    expect(r.requested).toBe(100);
    // The fixture reproduces the bug: timestamp lookups fail past the first fraction of a second.
    expect(r.servedByTimestamp).toBeLessThan(50);
    expect(r.count).toBe(100);
    expect(r.totalMs).toBe(4000);
    expect(r.distinct).toBeGreaterThan(90);
    expect(r.warnings).toEqual([]);
  });

  test('video → GIF in source colour samples its palette across the whole clip', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.videoGifPalette());
    console.log('palette', JSON.stringify(r));
    expect(r.sampled.count).toBe(30);
    // The late, saturated part keeps its colour only when the palette saw it.
    expect(r.sampled.lastChroma).toBeGreaterThan(60);
    expect(r.firstFramesOnly.lastChroma).toBeLessThan(r.sampled.lastChroma / 2);
  });

  test('a large GIF exports in source colour while the preview keeps playing it', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.bigGifSourceColour());
    expect(r.count).toBe(12);
    expect(r.previewFrames, 'the preview kept pulling frames meanwhile').toBeGreaterThan(12);
  });

  test('closing the media mid-export does not break GIF or animation → MP4 exports', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.disposeDuringExport());
    for (const format of ['gif', 'mp4']) {
      const x = r[format] as { disposedMidway: boolean; frames: number; expected: number; releasedAfter: boolean };
      expect(x.disposedMidway, format).toBe(true);
      expect(x.frames, format).toBe(x.expected);
      expect(x.releasedAfter, format).toBe(true);
    }
  });

  test('GIF export is cancellable', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.gifCancel());
    expect(r.aborted).toBe(true);
    expect(r.seen).toBeGreaterThanOrEqual(3);
  });

  for (const format of ['mp4', 'webm'] as const) {
    test(`${format}: a 2 s synthetic clip decodes back with the right duration, frames and even size`, async ({ page }) => {
      const durations = new Array(60).fill(1000 / 30);
      const r = await page.evaluate(([f, d]) => window.exportHarness.video({ format: f as 'mp4' | 'webm', durations: d as number[] }), [
        format,
        durations,
      ] as const);
      expect(r.warnings).toEqual([]);
      expect(r.fileName).toBe(`synthetic-ascii-80x${Math.round((80 * 180) / 320 * (8 / 17))}.${format}`);
      expect(r.probe.codec).toBe(format === 'mp4' ? 'avc' : 'vp9');
      expect(Math.abs(r.probe.duration - 2)).toBeLessThanOrEqual(1 / 30 + 1e-6);
      expect(r.probe.decoded).toBe(60);
      expect(r.probe.width % 2).toBe(0);
      expect(r.probe.height % 2).toBe(0);
      expect(r.probe.cornerAlpha).toBe(255);
      expect({ width: r.probe.width, height: r.probe.height }).toEqual({ width: r.width, height: r.height });
      // 80 cols × 8 px = 640; 21 rows × 17 px = 357 → padded to 358
      expect(r.height).toBe(358);
      save(`synthetic-2s.${format}`, r.base64);
      save(`synthetic-2s-${format}-frame.png`, r.probe.thumbnails[1]);
    });
  }

  test('video at an exact width: resampled in a worker, padded (never scaled) to even dimensions', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.video({ format: 'mp4', durations: new Array(10).fill(100), targetWidth: 333 }));
    // 80 cols × 8 px at 1× is 640 px wide and 21 rows × 17 px = 357 px tall: 333 px wide keeps that aspect.
    const height = Math.round((333 * 357) / 640);
    expect({ width: r.width, height: r.height }).toEqual({ width: 334, height: height + (height % 2) });
    expect({ width: r.probe.width, height: r.probe.height }).toEqual({ width: r.width, height: r.height });
    expect(r.probe.decoded).toBe(10);
  });

  test('webm: transparent background keeps alpha (VP9)', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.video({ format: 'webm', durations: new Array(10).fill(100), transparent: true }));
    expect(r.probe.codec).toBe('vp9');
    expect(r.probe.canBeTransparent).toBe(true);
    expect(r.probe.cornerAlpha).toBe(0);
    expect(r.probe.decoded).toBe(10);
    expect(Math.abs(r.probe.duration - 1)).toBeLessThanOrEqual(0.1 + 1e-6);
  });

  test('video → video: testsrc2_4s.mp4 converts with a per-frame process callback and keeps its duration', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.convert({ url: '/tests/fixtures/testsrc2_4s.mp4', format: 'mp4' }));
    const frame = 1 / r.source.fps;
    expect(Math.abs(r.probe.videoDuration - r.source.durationSec)).toBeLessThanOrEqual(frame + 1e-6);
    expect(Math.abs(r.probe.decoded - Math.round(r.source.durationSec * r.source.fps))).toBeLessThanOrEqual(1);
    expect(r.probe.width % 2).toBe(0);
    expect(r.probe.height % 2).toBe(0);
    expect(r.probe.codec).toBe('avc');
    if (r.source.hasAudio) expect(r.probe.audioCodec).not.toBeNull();
    expect(r.progressCount).toBeGreaterThan(10);
    save('testsrc2-ascii.mp4', r.base64);
    r.probe.thumbnails.forEach((t: string, i: number) => save(`testsrc2-ascii-frame${i}.png`, t));
  });

  test('video → video: trim 1–3 s to WebM', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.exportHarness.convert({ url: '/tests/fixtures/testsrc2_4s.mp4', format: 'webm', startSec: 1, endSec: 3 }),
    );
    const frame = 1 / r.source.fps;
    expect(Math.abs(r.probe.videoDuration - 2)).toBeLessThanOrEqual(frame + 1e-6);
    expect(Math.abs(r.probe.decoded - Math.round(2 * r.source.fps))).toBeLessThanOrEqual(1);
    expect(r.probe.codec).toBe('vp9');
    save('testsrc2-trim.webm', r.base64);
  });

  test('video → video keeps audio: copied into MP4, transcoded for WebM, dropped on request', async ({ page }) => {
    const mp4 = await page.evaluate(() => window.exportHarness.convert({ synthAudio: 'aac', format: 'mp4' }));
    expect(mp4.source.hasAudio).toBe(true);
    expect(mp4.probe.audioCodec).toBe('aac');
    // Tolerance: AAC's 1024-sample frames plus encoder priming (~45 ms) already in the source.
    expect(Math.abs((mp4.probe.audioDuration ?? 0) - 2)).toBeLessThan(0.1);
    expect(mp4.warnings).toEqual([]);
    save('av-aac-ascii.mp4', mp4.base64);

    // WebM cannot hold AAC: Mediabunny transcodes it to Opus.
    const webm = await page.evaluate(() => window.exportHarness.convert({ synthAudio: 'aac', format: 'webm', startSec: 0.5, endSec: 1.5 }));
    expect(webm.probe.audioCodec).toBe('opus');
    expect(Math.abs((webm.probe.audioDuration ?? 0) - 1)).toBeLessThan(0.1);
    expect(Math.abs(webm.probe.videoDuration - 1)).toBeLessThanOrEqual(1 / 30 + 1e-6);

    const silent = await page.evaluate(() => window.exportHarness.convert({ synthAudio: 'opus', format: 'mp4', includeAudio: false }));
    expect(silent.probe.audioCodec).toBeNull();
  });

  test('Opus audio becomes AAC in an MP4, so it plays in every player', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.convert({ synthAudio: 'opus', format: 'mp4' }));
    expect(r.probe.audioCodec).toBe('aac');
    expect(Math.abs((r.probe.audioDuration ?? 0) - 2)).toBeLessThan(0.1);
    expect(r.warnings.join(' ')).toMatch(/Audio converted from Opus to AAC/);
  });

  test('video → video is cancellable', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.convertCancel('/tests/fixtures/testsrc2_4s.mp4'));
    expect(r.aborted).toBe(true);
  });

  test('without WebCodecs, video falls back to real-time MediaRecorder capture (labelled)', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.realtime({}));
    expect(r.size).toBeGreaterThan(1000);
    expect(r.type).toMatch(/^video\//);
    expect(r.warnings.join(' ')).toMatch(/real time/);
    save('realtime.webm', r.base64);
  });

  test('estimate reports exact sizes, padding, limits and frame counts', async ({ page }) => {
    const png = await page.evaluate(() => window.exportHarness.estimate('png', { scale: 2 }));
    expect(png).toMatchObject({ width: 1280, height: 2 * 17 * Math.round((80 * 1080) / 1920 * (8 / 17)), supported: true });
    const big = await page.evaluate(() => window.exportHarness.estimate('png', { scale: 4 }, 2048));
    expect(big.supported).toBe(false);
    expect(big.notes.join(' ')).toMatch(/Use 3× or lower/);
    const mp4 = await page.evaluate(() => window.exportHarness.estimate('mp4', { startSec: 1, endSec: 3 }));
    expect(mp4.frames).toBe(60);
    expect(mp4.supported).toBe(true);
    expect((mp4.height ?? 1) % 2).toBe(0);
    const gif = await page.evaluate(() => window.exportHarness.estimate('gif', {}));
    expect(gif.frames).toBe(100); // 4 s at the 25 fps GIF cap
    expect(gif.bytes).toBeGreaterThan(0);
    expect(mp4.bytes).toBeGreaterThan(0);
    const exact = await page.evaluate(() => window.exportHarness.estimate('png', { targetWidth: 1920 }));
    expect({ width: exact.width, height: exact.height }).toEqual({ width: 1920, height: Math.round((1920 * png.height!) / png.width!) });
  });

  test('estimated bytes land near the real files (PNG, GIF, TXT)', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.estimateVsActual());
    console.log('estimate vs actual', JSON.stringify(r));
    for (const [name, { estimate, actual }] of Object.entries(r)) {
      expect(estimate, name).toBeGreaterThan(0);
      const ratio = estimate! / actual;
      // A GIF's size depends on how much moves, which a single frame cannot tell: within a factor of 6.
      const [low, high] = name.startsWith('gif') ? [1 / 6, 6] : [0.5, 2];
      expect(ratio, `${name}: ${estimate} vs ${actual}`).toBeGreaterThan(low);
      expect(ratio, `${name}: ${estimate} vs ${actual}`).toBeLessThan(high);
    }
    expect(r.txt.estimate).toBe(r.txt.actual);
  });

  test('SVG (outlines and text) parses and places glyphs exactly where canvas text draws them', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.svgVsCanvas());
    for (const variant of ['outlines', 'text'] as const) {
      const v = r[variant];
      expect(v.parseError).toBe(false);
      expect(v.root).toBe('svg');
      const scores = v.alignment;
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      console.log(variant, 'corr at 0,0 =', scores['0,0'].toFixed(3), '±1 px x:', scores['1,0'].toFixed(3), 'y:', scores['0,1'].toFixed(3), 'bytes', v.bytes);
      save(`svg-${variant}.png`, v.png);
      saveText(`grid-${variant}.svg`, v.svg);
      save('svg-reference.png', r.reference);
      expect(best[0]).toBe('0,0');
      expect(scores['0,0']).toBeGreaterThan(0.9);
      expect(scores['1,0']).toBeLessThan(scores['0,0'] - 0.1);
    }
  });

  // Minimum correlation: glyph modes are compared against hinted, font-smoothed canvas text (strokes
  // render slightly bolder than the outline fill); shape modes against identical geometry.
  const engineModes: Array<[string, Record<string, string | number>, number]> = [
    ['shape', { mode: 'shape' }, 0.94],
    ['shape-source', { mode: 'shape', colorMode: 'source' }, 0.94],
    ['ramp-duotone', { mode: 'ramp', colorMode: 'duotone' }, 0.94],
    ['braille', { mode: 'braille' }, 0.98],
    ['blocks', { mode: 'blocks' }, 0.99],
    ['blocks-source', { mode: 'blocks', colorMode: 'source' }, 0.99],
    ['halftone-round', { mode: 'halftone', halftoneShape: 'round' }, 0.98],
    ['halftone-square', { mode: 'halftone', halftoneShape: 'square', halftoneAngle: 30 }, 0.98],
    ['halftone-diamond', { mode: 'halftone', halftoneShape: 'diamond' }, 0.98],
    ['halftone-line', { mode: 'halftone', halftoneShape: 'line' }, 0.98],
  ];
  for (const [name, params, minCorr] of engineModes) {
    test(`SVG ${name} matches the engine's CPU raster of the same snapshot`, async ({ page }) => {
      const r = await page.evaluate((p) => window.exportHarness.svgVsEngine(p), params);
      const scores = r.alignment;
      console.log(name, `${r.grid.cols}x${r.grid.rows}`, 'corr 0,0 =', scores['0,0'].toFixed(3), '1,0 =', scores['1,0'].toFixed(3), '0,1 =', scores['0,1'].toFixed(3), 'bytes', r.bytes);
      save(`engine-${name}.png`, r.enginePng);
      save(`engine-${name}-svg.png`, r.svgPng);
      saveText(`engine-${name}.svg`, r.svg);
      expect(r.parseError).toBe(false);
      expect(r.warnings).toEqual([]);
      expect(r.svgSize).toEqual(r.size);
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      expect(best[0]).toBe('0,0');
      expect(scores['0,0']).toBeGreaterThan(minCorr);
    });
  }

  // Geist Mono at 1.2 / 1.5 and Plex at 1.0 put HTML text 1 px above the PNG; braille / blocks /
  // halftone rows were up to 14% wider than the PNG.
  const htmlCases: Array<[string, Record<string, string | number>]> = [
    ['geist 1.2', { font: 'geist-mono', lineHeight: 1.2 }],
    ['geist 1.5', { font: 'geist-mono', lineHeight: 1.5 }],
    ['plex 1.0', { font: 'ibm-plex-mono', lineHeight: 1 }],
    ['jetbrains 1.2 source', { font: 'jetbrains-mono', lineHeight: 1.2, colorMode: 'source' }],
    ['braille', { font: 'geist-mono', mode: 'braille' }],
    ['blocks', { font: 'geist-mono', mode: 'blocks', colorMode: 'source' }],
    ['halftone', { font: 'geist-mono', mode: 'halftone' }],
  ];
  for (const [name, params] of htmlCases) {
    test(`HTML ${name}: exactly the PNG's size, glyphs on the PNG's baseline`, async ({ page }) => {
      const r = await page.evaluate((p) => window.exportHarness.htmlVsEngine(p), params);
      expect(Math.abs(r.laidOut.width - r.size.width), `${name} width`).toBeLessThanOrEqual(0.5);
      expect(r.laidOut.height, `${name} height`).toBe(r.size.height);
      const shot = await page.locator('#html-frame').screenshot();
      const scores = await page.evaluate((b64) => window.exportHarness.compareHtmlShot(b64), shot.toString('base64'));
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      console.log(`HTML ${name}`, r.tag, 'corr 0,0 =', scores['0,0'].toFixed(3), '0,1 =', scores['0,1'].toFixed(3), '0,-1 =', scores['0,-1'].toFixed(3));
      expect(best[0], `${name}: best alignment`).toBe('0,0');
      expect(scores['0,0']).toBeGreaterThan(0.85);
    });
  }

  test('HTML <pre> lays out at exactly cols·cellW × rows·cellH with the embedded font', async ({ page }) => {
    const r = await page.evaluate(() => window.exportHarness.htmlLayout());
    expect(r.fontLoaded).toBe(true);
    expect(Math.abs(r.width - r.expected.width)).toBeLessThanOrEqual(1);
    expect(r.height).toBeCloseTo(r.expected.height, 0);
    expect(r.fileName).toBe('grid-ascii-64x10.html');
    expect(r.embedsBundledFont).toBe(true);
    saveText('grid.html', r.html);
  });
});

test.describe('export (local corpus)', () => {
  test.skip(!CORPUS || !existsSync(join(CORPUS ?? '', 'videos')), 'ASCII_CORPUS_DIR not set');
  test.beforeEach(async ({ page }) => open(page));

  const cases = [
    { file: 'golden_gate_6s_720p.mp4', format: 'mp4' as const, startSec: 1, endSec: 4, compareTimestamps: true },
    { file: 'siri_portrait_8s.mp4', format: 'webm' as const, compareTimestamps: true },
    { file: 'reframe_hevc_original.m4v', format: 'mp4' as const, endSec: 3 },
    { file: 'reframe_portrait_4s.webm', format: 'mp4' as const },
  ];
  for (const c of cases) {
    test(`converts ${c.file} → ${c.format}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setInputFiles('#file', join(CORPUS!, 'videos', c.file));
      const r = await page.evaluate(
        (spec) =>
          window.exportHarness.convert({
            useFileInput: true,
            format: spec.format,
            startSec: spec.startSec,
            endSec: spec.endSec,
            columns: 120,
            compareTimestamps: spec.compareTimestamps,
          }),
        c,
      );
      const expected = (c.endSec ?? r.source.durationSec) - (c.startSec ?? 0);
      console.log(c.file, JSON.stringify({ source: r.source, out: { w: r.probe.width, h: r.probe.height, d: r.probe.videoDuration, n: r.probe.decoded, audio: r.probe.audioCodec }, warnings: r.warnings, ms: Math.round(r.ms) }));
      expect(Math.abs(r.probe.videoDuration - expected)).toBeLessThanOrEqual(2 / r.source.fps + 1e-6);
      expect(r.probe.width % 2).toBe(0);
      expect(r.probe.height % 2).toBe(0);
      if (r.source.height > r.source.width) expect(r.probe.height).toBeGreaterThan(r.probe.width);
      if (r.source.hasAudio) expect(r.probe.audioCodec).not.toBeNull();
      if (c.compareTimestamps) expect(r.maxTimestampDelta).toBeLessThan(0.001);
      save(`corpus-${c.file}.${c.format}`, r.base64);
      save(`corpus-${c.file}-frame.png`, r.probe.thumbnails[1]);
    });
  }
});
