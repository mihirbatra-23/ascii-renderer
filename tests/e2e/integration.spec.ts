import { expect, test, type Page } from '@playwright/test';
import type { RenderParams } from '../../src/engine/types';

/**
 * End to end without UI (dev/integration.html): real media loaders, the real engine (WebGL2, and
 * the CPU fallback once) and the real exporters, wired as the app must wire them. Expected sizes
 * are recomputed here from the §1 formula, never taken from the code under test.
 */

let pageErrors: string[] = [];

async function open(page: Page): Promise<void> {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/dev/integration.html');
  await page.waitForFunction(() => !!window.integrationHarness);
}

test.afterEach(() => expect(pageErrors, 'uncaught page errors').toEqual([]));

const fixture = (name: string) => `/tests/fixtures/${name}`;

interface StillCase {
  name: string;
  file: string;
  params: Partial<RenderParams>;
  scale: number;
  margin: number;
}

const STILLS: StillCase[] = [
  { name: 'shape mono', file: 'torus_450.png', params: { mode: 'shape', columns: 120 }, scale: 2, margin: 0 },
  { name: 'blocks source colour', file: 'terrain_640x360.png', params: { mode: 'blocks', colorMode: 'source', columns: 160 }, scale: 1, margin: 6 },
  { name: 'braille duotone', file: 'waves_600x400.png', params: { mode: 'braille', colorMode: 'duotone', columns: 100 }, scale: 3, margin: 0 },
  { name: 'halftone over alpha', file: 'logo_rgba_256.png', params: { mode: 'halftone', columns: 64 }, scale: 1, margin: 4 },
  {
    name: 'ramp dense, EXIF portrait, Plex lh 1.5',
    file: 'exif6_480x270.jpg',
    params: { mode: 'ramp', charsetPreset: 'dense', font: 'ibm-plex-mono', lineHeight: 1.5, colorMode: 'source', columns: 90 },
    scale: 2,
    margin: 2,
  },
  {
    name: 'shape dense, light paper, Geist lh 1.0',
    file: 'gradient_512x64.png',
    params: { mode: 'shape', charsetPreset: 'dense', font: 'geist-mono', lineHeight: 1, ink: '#111111', paper: '#f4f1ea', columns: 300 },
    scale: 1,
    margin: 0,
  },
];

test.describe('integration: stills', () => {
  test.beforeEach(async ({ page }) => open(page));

  for (const c of STILLS) {
    test(`${c.name} (${c.file}): preview, PNG, TXT, SVG and HTML share one geometry`, async ({ page }) => {
      const r = await page.evaluate((spec) => window.integrationHarness.still(spec), {
        url: fixture(c.file),
        params: c.params,
        scale: c.scale,
        margin: c.margin,
      });
      const { cols, rows } = r.grid;
      expect(r.backend).toBe('webgl2');
      expect(r.grid).toEqual(r.expectedGrid);
      expect(r.stats).toEqual(r.grid);
      expect(r.snapshotGrid).toEqual({ cols, rows, cells: cols * rows });
      expect(r.previewStd, 'preview is not blank').toBeGreaterThan(2);
      expect(r.inkedCells).toBeGreaterThan(0);

      expect(r.png.decoded.width).toBe(r.png.expected.width);
      expect(r.png.decoded.height).toBe(r.png.expected.height);
      expect(r.png.declared).toEqual(r.png.expected);
      expect(r.png.decoded.lumaStd, 'PNG is not blank').toBeGreaterThan(2);
      expect(r.png.warnings).toEqual([]);
      expect(r.png.fileName).toMatch(new RegExp(`-ascii-${cols}x${rows}\\.png$`));

      expect(r.txt.rows).toBe(rows);
      expect(r.txt.finalLine).toBe('');
      expect(r.txt.lengths).toEqual([cols]);
      expect(r.txt.crlfRows).toBe(rows);
      expect(r.txt.sameAsSnapshot).toBe(true);
      expect(r.txt.charsMatch).toBe(true);

      const viewBox = `0 0 ${r.svg.expected.width} ${r.svg.expected.height}`;
      for (const svg of [r.svg.outlines, r.svg.text]) {
        expect(svg.wellFormed).toBe(true);
        expect(svg.viewBox).toBe(viewBox);
        expect(svg.width).toBe(String(r.svg.expected.width));
        expect(svg.height).toBe(String(r.svg.expected.height));
        expect(svg.warnings).toEqual([]);
      }
      expect(r.svg.outlines.shapes).toBeGreaterThan(1);
      const glyphMode = c.params.mode === 'shape' || c.params.mode === 'ramp';
      if (glyphMode) expect(r.svg.text.texts).toBe(rows);
      else expect(r.svg.text.shapes).toBeGreaterThan(1);

      expect(r.html.rows).toEqual(r.html.expectedRows);
      expect(r.html.size, 'the HTML page is the PNG at 1×').toEqual(r.html.expectedSize);
      expect(r.html.warnings).toEqual([]);
      expect(r.unchangedAfterExport).toBe(true);
    });
  }

  test('CPU fallback engine: same grid formula and exact export sizes', async ({ page }) => {
    const r = await page.evaluate((spec) => window.integrationHarness.still(spec), {
      url: fixture('torus_450.png'),
      backend: 'cpu' as const,
      params: { mode: 'shape' as const, columns: 120 },
      scale: 2,
      margin: 3,
    });
    expect(r.backend).toBe('cpu');
    expect(r.grid).toEqual(r.expectedGrid);
    expect(r.previewStd).toBeGreaterThan(2);
    expect(r.png.decoded.width).toBe(r.png.expected.width);
    expect(r.png.decoded.height).toBe(r.png.expected.height);
    expect(r.txt.rows).toBe(r.grid.rows);
    expect(r.txt.lengths).toEqual([r.grid.cols]);
    expect(r.svg.outlines.wellFormed).toBe(true);
    expect(r.svg.outlines.viewBox).toBe(`0 0 ${r.svg.expected.width} ${r.svg.expected.height}`);
    expect(r.unchangedAfterExport).toBe(true);
  });
});

test.describe('integration: animation and video', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('GIF → player → engine → GIF export: 24 frames, delays and loop count preserved', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.integrationHarness.gif({
        url: '/tests/fixtures/transparent_variable_duration.gif',
        params: { mode: 'shape', colorMode: 'source', columns: 80 },
        scale: 1,
        margin: 0,
      }),
    );
    const durations = Array.from({ length: 24 }, (_, i) => (i % 2 ? 40 : 120));
    expect(r.media).toMatchObject({ frameCount: 24, durations, loopCount: 0, hasAlpha: true });
    expect(r.decoded.count).toBe(24);
    expect(r.decoded.delays).toEqual(durations);
    expect(r.decoded.loop, 'loops forever like the source').toBe(0);
    expect({ width: r.decoded.width, height: r.decoded.height }).toEqual(r.expected);
    expect({ width: r.result.width, height: r.result.height }).toEqual(r.expected);
    expect(r.result.warnings).toEqual([]);
    expect(r.result.fileName).toBe(`transparent_variable_duration-ascii-${r.grid.cols}x${r.grid.rows}.gif`);
    expect(r.stepChangesGrid).toBe(true);
    expect(r.played, 'frames emitted during 400 ms of playback').toBeGreaterThan(2);
    expect(r.restoredMatchesFirst).toBe(true);
  });

  test('GIF loop count: source plays map to the right NETSCAPE repeat count', async ({ page }) => {
    // NETSCAPE n plays n + 1 times; no extension plays once (media/types.ts LoadedAnimation.loopCount).
    for (const [loop, plays, netscape] of [
      [undefined, 1, -1],
      [0, 0, 0],
      [2, 3, 2],
    ] as const) {
      const r = await page.evaluate((l) => window.integrationHarness.gifLoop(l), loop);
      expect(r.sourcePlays, `source NETSCAPE ${loop}`).toBe(plays);
      expect(r.decoded.loop, `source NETSCAPE ${loop}`).toBe(netscape);
      expect(r.decoded.count).toBe(2);
      expect(r.decoded.delays).toEqual([100, 200]);
    }
  });

  test('MP4 → player → engine → MP4 export: ≈ 4 s, every frame, even exact size', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.integrationHarness.video({
        url: '/tests/fixtures/testsrc2_4s.mp4',
        format: 'mp4',
        params: { mode: 'shape', colorMode: 'source', columns: 120 },
        scale: 1,
        margin: 0,
      }),
    );
    const frame = 1 / r.media.fps;
    expect(r.media.durationSec).toBeCloseTo(4, 1);
    expect(r.media.canDecodeFrames).toBe(true);
    expect(r.playheadAfterLevels, 'auto-levels sampling does not move the playhead').toBe(0);
    expect(r.seekChangesGrid).toBe(true);
    expect(r.played, 'frames presented during 600 ms of playback').toBeGreaterThan(5);
    expect(r.renders).toBeGreaterThan(5);

    expect(r.probe.codec).toBe('avc');
    expect({ width: r.probe.width, height: r.probe.height }).toEqual(r.expected);
    expect({ width: r.result.width, height: r.result.height }).toEqual(r.expected);
    expect(Math.abs(r.probe.duration - r.media.durationSec)).toBeLessThanOrEqual(frame + 1e-3);
    expect(Math.abs(r.probe.packets - Math.round(r.media.durationSec * r.media.fps))).toBeLessThanOrEqual(1);
    expect(r.probe.firstTimestamp).toBeLessThan(frame);
    expect(r.result.warnings).toEqual([]);
    expect(r.result.fileName).toBe(`testsrc2_4s-ascii-${r.grid.cols}x${r.grid.rows}.mp4`);
    expect(r.restoredMatchesStart).toBe(true);
  });

  test('a video WebCodecs cannot decode is recorded from playback instead of failing', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.integrationHarness.undecodableVideo({
        url: '/tests/fixtures/testsrc2_4s.mp4',
        params: { mode: 'shape', columns: 80 },
        scale: 1,
        margin: 0,
        endSec: 1,
      }),
    );
    expect(r.estimates.webm.supported).toBe(true);
    expect(r.estimates.webm.notes.join(' ')).toMatch(/This browser will record the video in real time, without audio/);
    expect(r.estimates.gif.supported).toBe(false);
    expect(r.result.warnings.join(' ')).toMatch(/Recorded in real time\. Frame timing may be uneven/);
    expect(r.result.type).toMatch(/^video\/webm/);
    expect({ width: r.probe.width, height: r.probe.height }).toEqual(r.expected);
    // Real-time capture of 1 s of playback: frame timing follows the wall clock.
    expect(r.probe.duration).toBeGreaterThan(0.6);
    expect(r.probe.duration).toBeLessThan(1.5);
    expect(r.probe.packets).toBeGreaterThan(10);
    expect(r.elementRestored).toEqual({ time: 0, paused: true, muted: true });
  });

  test('GIF → transparent WebM (frame sequence path): duration, frames and alpha', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.integrationHarness.animationToVideo({
        url: '/tests/fixtures/transparent_variable_duration.gif',
        params: { mode: 'shape', columns: 80 },
        scale: 1,
        margin: 4,
      }),
    );
    expect(r.probe.codec).toBe('vp9');
    expect({ width: r.probe.width, height: r.probe.height }).toEqual(r.expected);
    expect(r.probe.packets).toBe(r.frameCount);
    expect(r.probe.duration).toBeCloseTo(r.totalSec, 2);
    expect(r.probe.cornerAlpha, 'the margin stays transparent').toBe(0);
    expect(r.result.warnings).toEqual([]);
  });
});

test.describe('integration: exports keep the editor responsive', () => {
  test.beforeEach(async ({ page }) => open(page));

  // Before: a 2× MP4 of testsrc2 spent 97% of its wall time in long tasks (119 tasks, up to 108 ms,
  // rAF p95 67 ms); a 2× GIF ~90% at about 7–10 fps.
  for (const format of ['mp4', 'gif'] as const) {
    test(`2× ${format.toUpperCase()} of a video: the main thread stays free`, async ({ page }) => {
      // Chrome reports WebGL performance problems as console warnings; after ~32 of them it stops
      // reporting WebGL errors for the page, so an export must not cost one per frame (reusing a
      // fenced pixel-pack buffer without new storage did: 119 for this MP4).
      const webglWarnings: string[] = [];
      page.on('console', (m) => /WebGL|READ-usage/.test(m.text()) && webglWarnings.push(m.text()));
      const r = await page.evaluate(
        (f) =>
          window.integrationHarness.exportJank({
            url: '/tests/fixtures/testsrc2_4s.mp4',
            format: f,
            params: { mode: 'shape', colorMode: 'source', columns: 160 },
            scale: 2,
            margin: 0,
          }),
        format,
      );
      console.log(format, JSON.stringify(r));
      expect(r.outcome).toBe('done');
      expect(r.size).toEqual({ width: 2560, height: 1440 });
      if (format === 'mp4') expect(r.frames).toBe(120);
      else expect(r.gifFrames).toBe(100);
      expect(r.blockedPct, 'share of the export spent in long tasks').toBeLessThan(25);
      expect(r.rafGapMs.p95, 'frames keep coming').toBeLessThan(50);
      expect(webglWarnings, 'WebGL console warnings during the export').toEqual([]);
    });
  }

  test('Cancel lands within a frame', async ({ page }) => {
    for (const format of ['mp4', 'gif'] as const) {
      const r = await page.evaluate(
        (f) =>
          window.integrationHarness.exportJank({
            url: '/tests/fixtures/testsrc2_4s.mp4',
            format: f,
            params: { mode: 'shape', columns: 160 },
            scale: 2,
            margin: 0,
            cancelAfterMs: 700,
          }),
        format,
      );
      expect(r.outcome, format).toBe('cancelled');
      expect(r.cancelMs!, format).toBeLessThan(250);
    }
  });

  test('a 4× PNG at 400 columns reads back without a long freeze', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.integrationHarness.exportJank({ url: '/tests/fixtures/testsrc2_4s.mp4', format: 'png', params: { columns: 400 }, scale: 4, margin: 0 }),
    );
    console.log('png 4x', JSON.stringify(r));
    expect(r.size!.width).toBe(400 * 8 * 4);
    // Before: one 1.2–2.7 s long task (synchronous readPixels + PNG encoding on the main thread).
    expect(r.longTasks.maxMs).toBeLessThan(400);
  });

  test('a PNG names the grid its pixels show, even when params change during the export', async ({ page }) => {
    const r = await page.evaluate(() => window.integrationHarness.pngNameMatchesPixels());
    expect(r.gridNow.cols).toBe(90);
    expect(r.pixelsGrid.cols).toBe(120);
    expect(r.fileName).toBe(`terrain_640x360-ascii-${r.pixelsGrid.cols}x${r.pixelsGrid.rows}.png`);
  });

  test('a PNG at an exact width is exactly that wide, with the grid aspect', async ({ page }) => {
    for (const width of [1920, 1000, 777]) {
      const r = await page.evaluate((w) => window.integrationHarness.pngTargetWidth(w), width);
      const height = Math.round((width * r.base.height) / r.base.width);
      expect({ width: r.decoded.width, height: r.decoded.height }).toEqual({ width, height });
      expect(r.declared).toEqual({ width, height });
      expect(r.decoded.lumaStd).toBeGreaterThan(2);
    }
  });
});

test.describe('integration: robustness', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('WebGL context restore with a closed source frame does not throw; the next frame renders', async ({ page }) => {
    const r = await page.evaluate(() => window.integrationHarness.contextRestoreWithClosedFrame());
    expect(r.after.cols).toBe(60);
    expect(r.after.rows).toBeGreaterThan(0);
    expect(r.inked).toBe(true);
  });

  test('frames without pixels (video not ready, closed bitmap) render nothing on both backends instead of throwing', async ({ page }) => {
    for (const backend of ['webgl2', 'cpu'] as const) {
      const r = await page.evaluate((b) => window.integrationHarness.framesWithoutPixels(b), backend);
      expect(r).toEqual({
        backend,
        closedRender: 'ok',
        closedSnapshot: 'The source has no pixels yet (is the video loaded?).',
        videoRender: 'ok',
      });
    }
  });
});
