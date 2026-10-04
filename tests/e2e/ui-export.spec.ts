import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';
import { liveRegionsSaying } from './liveRegions';

/**
 * Transport and Export panel in the real app: open media through the controller, drive the
 * transport, and export every format through the panel (download events, real files).
 * Set UI_SHOTS_DIR to also save screenshots for design review.
 */
const SHOTS = process.env.UI_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// App modules are imported by URL inside the page (strings, so tsc does not try to resolve them).
async function openMedia(page: Page, url: string, name: string): Promise<void> {
  await page.evaluate(`${appImport('/src/app/controller.ts')}.then((c) => c.openSample(${JSON.stringify(url)}, ${JSON.stringify(name)}))`);
  await page.waitForFunction(`${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().media.status === 'ready')`);
}

async function boot(page: Page, theme?: 'b'): Promise<void> {
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
  await page.goto('/');
  if (theme) await page.evaluate(() => (document.documentElement.dataset.theme = 'b'));
  await page.evaluate(() => document.fonts.ready);
}

/** Width and height of a downloaded PNG, decoded by the browser. */
async function pngSize(page: Page, path: string): Promise<number[]> {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    return [bmp.width, bmp.height];
  }, readFileSync(path).toString('base64'));
}

/** Bytes of the panel's "≈ 914 KB" or "≈ 1.9–3.1 MB" estimate, as [low, high]. */
function parseEstimate(text: string): [number, number] {
  const m = /([\d.]+)(?:\s*(KB|MB|B))?(?:–([\d.]+))?\s*(KB|MB|B)/.exec(text.replace(/≈\s*/, ''));
  if (!m) throw new Error(`No size in "${text}"`);
  const unit = (u: string) => (u === 'MB' ? 1e6 : u === 'KB' ? 1e3 : 1);
  const low = Number(m[1]) * unit(m[2] ?? m[4]);
  return [low, m[3] ? Number(m[3]) * unit(m[4]) : low];
}

/** Sample count of an MP4's video track (its 'stsz' box; the exporter writes a non-fragmented file). */
function mp4VideoSamples(bytes: Buffer): number {
  const video = bytes.indexOf('vide', bytes.indexOf('hdlr'), 'latin1');
  const stsz = bytes.indexOf('stsz', video, 'latin1');
  if (video < 0 || stsz < 0) throw new Error('No video sample table in the MP4.');
  return bytes.readUInt32BE(stsz + 12);
}

const store = <T,>(page: Page, fn: string) =>
  page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore }) => (${fn})(useStore.getState()))`) as Promise<T>;

// Before any navigation, so every module the app loads can be found (./appModules).
test.beforeEach(({ page }) => trackAppModules(page));

test.describe('transport', () => {
  test('mirrors the player, scrubs, steps, trims, loops and changes speed', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/long_200_frames.gif', 'long_200_frames.gif');
    const tp = page.getByRole('group', { name: 'Playback' });
    await expect(tp).toBeVisible();
    await expect.poll(() => store<number>(page, '(s) => s.playback.frameCount')).toBe(200);

    // Pause, then scrub to the middle of the strip.
    if (await store<boolean>(page, '(s) => s.playback.playing')) await tp.getByRole('button', { name: 'Pause' }).click();
    await expect(tp.getByRole('button', { name: 'Play' })).toBeVisible();
    const strip = tp.getByRole('slider', { name: 'Timeline' });
    const box = (await strip.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => store<number>(page, '(s) => s.playback.frame')).toBeGreaterThan(90);
    const mid = await store<number>(page, '(s) => s.playback.frame');
    await expect(strip).toHaveAttribute('aria-valuenow', String(mid + 1));

    // Arrow keys on the focused strip step one frame.
    await strip.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => store<number>(page, '(s) => s.playback.frame')).toBe(mid + 1);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => store<number>(page, '(s) => s.playback.frame')).toBe(mid - 9);

    // In point from the field; Out from the keyboard bracket.
    const inField = tp.getByLabel('In point', { exact: true }).and(page.locator('input'));
    await inField.fill('00:01.00');
    await inField.press('Enter');
    await expect.poll(() => store<number>(page, '(s) => s.playback.inPoint')).toBeCloseTo(1, 1);
    // Escape reverts a typed value instead of committing it.
    await inField.fill('00:02.00');
    await inField.press('Escape');
    await expect(inField).not.toBeFocused();
    // Trim edges are frame boundaries: 1.00 s falls inside the 30 ms frame that starts at 0.99 s.
    await expect.poll(() => store<number>(page, '(s) => s.playback.inPoint')).toBeCloseTo(0.99, 6);
    await expect(inField).toHaveValue('00:00.99');
    const outHandle = tp.getByRole('slider', { name: 'Out point' });
    const outBefore = await store<number>(page, '(s) => s.playback.outPoint');
    await outHandle.focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => store<number>(page, '(s) => s.playback.outPoint')).toBeLessThan(outBefore);

    // Dragging the In bracket trims to the frame under the pointer.
    const inHandle = tp.getByRole('slider', { name: 'In point' });
    const hb = (await inHandle.boundingBox())!;
    const duration = await store<number>(page, '(s) => s.playback.duration');
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.25 - 5, hb.y + hb.height / 2, { steps: 5 });
    await expect(inHandle.locator('.hd-tip')).toBeVisible();
    await page.mouse.up();
    await expect.poll(() => store<number>(page, '(s) => s.playback.inPoint')).toBeCloseTo(duration * 0.25, 0);

    // Loop toggle and speed.
    const loop = tp.getByRole('button', { name: 'Loop' });
    const loopOn = (await loop.getAttribute('aria-pressed')) === 'true';
    await loop.click();
    await expect(loop).toHaveAttribute('aria-pressed', String(!loopOn));
    await tp.getByRole('radio', { name: '2×' }).click();
    await expect.poll(() => store<number>(page, '(s) => s.playback.rate')).toBe(2);

    // Playing at 2× runs the clip at twice the wall clock (the player itself has no rate).
    await store(page, "(s) => s.setPlayback({ loop: true })");
    await tp.getByRole('button', { name: 'Play' }).click();
    const sample = () =>
      page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore }) => ({ t: useStore.getState().playback.time, at: performance.now() }))`) as Promise<{ t: number; at: number }>;
    const a = await sample();
    await page.waitForTimeout(400);
    const b = await sample();
    const { inPoint, outPoint } = await store<{ inPoint: number; outPoint: number }>(page, '(s) => s.playback');
    const advanced = (b.t - a.t + (outPoint - inPoint)) % (outPoint - inPoint);
    expect(await store<boolean>(page, '(s) => s.playback.playing')).toBe(true);
    expect(advanced / ((b.at - a.at) / 1000)).toBeGreaterThan(1.6);
    expect(advanced / ((b.at - a.at) / 1000)).toBeLessThan(2.4);
  });

  // ⇧I / ⇧O pressed on a paused, mid-frame playhead set mid-frame edges, and the MP4 then held
  // a sliver of an extra frame (61 written where the panel promised 60).
  test('trim points set at a mid-frame playhead land on frame boundaries, and the file has the frames the panel says', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/testsrc2_4s.mp4', 'testsrc2_4s.mp4');
    const playback = appImport('/src/ui/transport/playback.ts');
    const seekTo = async (t: number) => {
      await page.evaluate(`${playback}.then((p) => { p.pause(); p.seek(${t}); })`);
      await expect.poll(() => store<number>(page, '(s) => s.playback.time')).toBeCloseTo(t, 3);
    };
    await page.locator('.stage').focus();
    await seekTo(1.017);
    await page.keyboard.press('Shift+I');
    await seekTo(3.017);
    await page.keyboard.press('Shift+O');
    // 30 fps: the frames shown at 1.017 s and 3.017 s start at 1.000 s and 3.000 s.
    await expect.poll(() => store<number>(page, '(s) => s.playback.inPoint')).toBeCloseTo(1, 6);
    await expect.poll(() => store<number>(page, '(s) => s.playback.outPoint')).toBeCloseTo(3, 6);

    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^MP4/ }).click();
    await dock.getByRole('radio', { name: /^1×/ }).click();
    await expect(dock.locator('.outcard')).toContainText('Frames60 · 2.00 s');
    const downloading = page.waitForEvent('download', { timeout: 110_000 });
    await dock.getByRole('button', { name: /^Download MP4/ }).click();
    const bytes = readFileSync(await (await downloading).path());
    expect(mp4VideoSamples(bytes)).toBe(60);
  });

  test('video: Space plays and pauses through the transport', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/testsrc2_4s.mp4', 'testsrc2_4s.mp4');
    await expect.poll(() => store<number>(page, '(s) => s.playback.duration')).toBeGreaterThan(3.9);
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    const before = await store<boolean>(page, '(s) => s.playback.playing');
    await page.keyboard.press('Space');
    await expect.poll(() => store<boolean>(page, '(s) => s.playback.playing')).toBe(!before);
  });
});

test.describe('export panel', () => {
  test('PNG download matches the size the panel shows', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await expect(dock.getByRole('heading', { name: 'Export' })).toBeVisible();
    await expect(dock.getByRole('radio', { name: /^GIF/ })).toBeDisabled();
    await dock.getByRole('radio', { name: /^2×/ }).click();
    const readout = await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label');
    const [, w, h] = /Output (\d+) by (\d+)/.exec(readout!)!;
    const [download] = await Promise.all([page.waitForEvent('download'), dock.getByRole('button', { name: /^Download PNG/ }).click()]);
    const path = await download.path();
    const size = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      return [bmp.width, bmp.height];
    }, readFileSync(path).toString('base64'));
    expect(size).toEqual([Number(w), Number(h)]);
    await expect(page.locator('.toast').filter({ hasText: /^Saved / }).first()).toBeVisible();
    // Announced once, by the toast host's polite region.
    expect(await liveRegionsSaying(page, 'Saved torus')).toBe(1);
  });

  test('SVG, TXT and HTML downloads', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    for (const [fmt, ext, probe] of [
      ['SVG', 'svg', '<svg'],
      ['TXT', 'txt', ''],
      ['HTML', 'html', '<pre'],
    ] as const) {
      await dock.getByRole('radio', { name: new RegExp(`^${fmt}`) }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), dock.getByRole('button', { name: `Download ${fmt}` }).click()]);
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${ext}$`));
      const text = readFileSync(await download.path(), 'utf8');
      expect(text.length).toBeGreaterThan(1000);
      if (probe) expect(text).toContain(probe);
    }
  });

  test('GIF from the GIF fixture: encodes in the background with progress, then downloads', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/long_200_frames.gif', 'long_200_frames.gif');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^GIF/ }).click();
    await dock.getByRole('radio', { name: /^1×/ }).click();
    const readout = await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label');
    // the estimate is measured from real delta frames.
    await expect(dock.locator('.facts3')).toContainText(/≈/, { timeout: 30_000 });
    const [low, high] = parseEstimate(await dock.locator('.facts3 > div').last().locator('dd').innerText());
    // PERF-EXP-START: starting the encode is not one long main-thread task.
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask' });
    });
    const downloading = page.waitForEvent('download', { timeout: 110_000 });
    await dock.getByRole('button', { name: /^Download GIF/ }).click();
    await expect(dock.getByRole('progressbar', { name: 'Encoding progress' })).toBeVisible();
    await expect(dock.getByText('Encoding in a worker. Keep editing.')).toBeVisible();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.gif$/);
    const bytes = readFileSync(await download.path());
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    // Logical screen size (little-endian) equals the panel's readout.
    expect(`Output ${bytes.readUInt16LE(6)} by ${bytes.readUInt16LE(8)} pixels`).toBe(readout);
    expect(bytes.length, `estimate ${low}–${high} bytes`).toBeGreaterThanOrEqual(low / 1.3);
    expect(bytes.length, `estimate ${low}–${high} bytes`).toBeLessThanOrEqual(high * 1.3);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log('GIF export long tasks', JSON.stringify(long.map(Math.round)));
    expect(long.filter((ms) => ms > 50)).toEqual([]);
  });

  test('MP4 from testsrc2_4s.mp4, and Cancel stops an encode', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/testsrc2_4s.mp4', 'testsrc2_4s.mp4');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^MP4/ }).click();
    await dock.getByRole('radio', { name: /^1×/ }).click();
    const downloading = page.waitForEvent('download', { timeout: 110_000 });
    await dock.getByRole('button', { name: /^Download MP4/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    const bytes = readFileSync(await download.path());
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(bytes.length).toBeGreaterThan(10_000);

    await dock.getByRole('button', { name: /^Download MP4/ }).click();
    await dock.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => store<string>(page, '(s) => s.job.status')).toBe('idle');
  });
});

test.describe('export panel behaviour', () => {
  test('⌘↵ downloads, Esc closes', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^TXT/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('ControlOrMeta+Enter')]);
    expect(download.suggestedFilename()).toMatch(/^torus-ascii-\d+x\d+\.txt$/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Adjust' })).toBeVisible();
  });

  test('Copy text puts the grid on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await store(page, "(s) => s.setParam('columns', 160)");
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    // The copy action follows the format: Copy PNG for PNG, Copy text for TXT.
    await expect(dock.getByRole('button', { name: 'Copy PNG' })).toBeVisible();
    await dock.getByRole('radio', { name: /^TXT/ }).click();
    await dock.getByRole('button', { name: 'Copy text' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Copied 45 lines of text' })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toHaveLength(160);
  });

  test('a typed file name is used with the real extension', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^SVG/ }).click();
    await dock.getByLabel('File name').fill('my/torus');
    const [download] = await Promise.all([page.waitForEvent('download'), dock.getByRole('button', { name: 'Download SVG' }).click()]);
    expect(download.suggestedFilename()).toBe('my-torus.svg');
  });

  test('an aspect that rounds is flagged, and the fix makes it exact', async ({ page }) => {
    await boot(page);
    await store(page, "(s) => s.setParam('columns', 160)");
    await openMedia(page, '/tests/fixtures/waves_600x400.png', 'waves_600x400.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await expect(dock.getByText(/^Rows round to 53, so the aspect is 1\.509/)).toBeVisible();
    await dock.getByRole('button', { name: 'Use 159 columns' }).click();
    await expect(dock.getByText('Same 3:2 aspect as the source 600 × 400: no crop, no squash.')).toBeVisible();
  });

  test('a custom width is exactly that wide, and ⌘↵ in the width field downloads it', async ({ page }) => {
    await boot(page);
    await store(page, "(s) => s.setParam('columns', 160)");
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^Custom/ }).click();
    const width = dock.getByLabel('Custom width in px');
    await width.fill('1920');
    // ⌘↵ commits the typed width and still reaches the download shortcut.
    const [download] = await Promise.all([page.waitForEvent('download'), width.press('ControlOrMeta+Enter')]);
    await expect(width).toHaveValue('1920');
    await expect(dock.getByRole('img', { name: 'Output 1920 by 1080 pixels' })).toBeVisible();
    await expect(dock.getByText(/^Resampled from 2×/)).toBeVisible();
    expect(await pngSize(page, await download.path())).toEqual([1920, 1080]);
  });

  test('GIF, MP4 and WebM start at 1× and keep their own scale; PNG keeps 2×', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/long_200_frames.gif', 'long_200_frames.gif');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await expect(dock.getByRole('radio', { name: /^GIF/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dock.getByRole('radio', { name: /^1×/ })).toHaveAttribute('aria-checked', 'true');
    // The weight is known before encoding.
    await expect(dock.locator('.facts3 div', { hasText: 'Est. size' }).locator('dd')).toHaveText(/^≈ \d/);
    await dock.getByRole('radio', { name: /^PNG/ }).click();
    await expect(dock.getByRole('radio', { name: /^2×/ })).toHaveAttribute('aria-checked', 'true');
    await dock.getByRole('radio', { name: /^4×/ }).click();
    await dock.getByRole('radio', { name: /^GIF/ }).click();
    await expect(dock.getByRole('radio', { name: /^1×/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('a scale this device cannot draw is never shown as chosen', async ({ page }) => {
    await boot(page);
    await store(page, "(s) => { s.setParam('columns', 400); s.setExportUi({ scale: 4 }); }");
    // A 5:9 portrait: 365 × 329 cells, so 4× is far beyond any canvas limit.
    await page.evaluate(`(async () => {
      const canvas = new OffscreenCanvas(1000, 1800);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#888';
      ctx.fillRect(0, 0, 1000, 1800);
      const { openFile } = await ${appImport('/src/app/controller.ts')};
      await openFile(await canvas.convertToBlob({ type: 'image/png' }), 'portrait.png');
    })()`);
    await page.waitForFunction(`${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().media.status === 'ready')`);
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    const checked = dock.getByRole('radiogroup', { name: 'Scale' }).getByRole('radio', { checked: true });
    await expect(checked).toBeEnabled();
    await expect(dock.getByText(/^4× would be .* more than this device can draw, so/)).toBeVisible();
    const readout = await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label');
    expect(readout).toContain(`Output ${(await checked.textContent())!.replace(/^\d×/, '').replace(/\s/g, '').replace('×', ' by ')} pixels`);
  });

  test('focus moves into the panel, stays on Download while exporting, and returns to Export', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await expect(dock.getByRole('radio', { name: /^PNG/ })).toBeFocused();
    const download = dock.getByRole('button', { name: /^Download PNG/ });
    await download.focus();
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    await expect(download).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Export/ })).toBeFocused();
  });

  test('an encode moves focus to Cancel, and Cancel gives it back to Download', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/testsrc2_4s.mp4', 'testsrc2_4s.mp4');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^MP4/ }).click();
    await dock.getByRole('button', { name: /^Download MP4/ }).focus();
    await page.keyboard.press('Enter');
    const cancel = dock.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    // The preview is paused for the encode.
    expect(await store<boolean>(page, '(s) => s.playback.playing')).toBe(false);
    await page.keyboard.press('Enter');
    await expect.poll(() => store<string>(page, '(s) => s.job.status')).toBe('idle');
    await expect(dock.getByRole('button', { name: /^Download MP4/ })).toBeFocused();
    // …and plays again afterwards.
    await expect.poll(() => store<boolean>(page, '(s) => s.playback.playing')).toBe(true);
  });

  test('Blocks in Source colour cannot be transparent, and the switch says why', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await store(page, "(s) => { s.setParams({ mode: 'blocks', colorMode: 'source' }); s.setExportUi({ transparent: true }); }");
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    const sw = dock.getByRole('switch', { name: /Transparent background/ });
    await expect(sw).toBeDisabled();
    await expect(sw).not.toBeChecked();
    await expect(dock.getByText(/paints both colours of every cell/)).toBeVisible();
  });

  test('Copy PNG puts the image on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    await dock.getByRole('radio', { name: /^1×/ }).click();
    await dock.getByRole('button', { name: 'Copy PNG' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Copied PNG' })).toBeVisible();
    const size = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bmp = await createImageBitmap(await item.getType('image/png'));
      return [bmp.width, bmp.height];
    });
    const readout = await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label');
    expect(`Output ${size[0]} by ${size[1]} pixels`).toBe(readout);
  });

  test('Escape in the file name field undoes the typing and keeps the panel open', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/samples/torus.png', 'torus.png');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    const name = dock.getByLabel('File name');
    const before = await name.inputValue();
    await name.fill('draft name');
    await page.keyboard.press('Escape');
    await expect(name).toHaveValue(before);
    await expect(name).not.toBeFocused();
    await expect(dock).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Adjust' })).toBeVisible();
  });

  test('opening another file during a GIF export does not stop it', async ({ page }) => {
    await boot(page);
    await openMedia(page, '/tests/fixtures/long_200_frames.gif', 'long_200_frames.gif');
    await page.keyboard.press('ControlOrMeta+e');
    const dock = page.getByRole('complementary', { name: 'Export' });
    const downloading = page.waitForEvent('download', { timeout: 110_000 });
    await dock.getByRole('button', { name: /^Download GIF/ }).click();
    await openMedia(page, '/samples/torus.png', 'torus.png');
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^long_200_frames.*\.gif$/);
  });
});

/** The board's video state: Ramp, trimmed 0.50–3.25 s, playhead at 1.42 s. */
async function boardVideoState(page: Page): Promise<void> {
  await openMedia(page, '/samples/interference_loop.mp4', 'interference_loop.mp4');
  await store(page, "(s) => s.setParam('mode', 'ramp')");
  await page.evaluate(`${appImport('/src/ui/transport/playback.ts')}.then((pb) => {
    pb.pause();
    pb.setInPoint(0.5);
    pb.setOutPoint(3.25);
    pb.seek(1.42);
  })`);
  await page.waitForTimeout(600);
}

test.describe('screenshots', () => {
  test.skip(!SHOTS, 'set UI_SHOTS_DIR to capture');

  for (const theme of [undefined, 'b'] as const) {
    test(`video editor and export ${theme ?? 'a'}`, async ({ page }) => {
      const tag = theme ?? 'a';
      for (const [w, h] of [
        [1440, 900],
        [1024, 768],
        [390, 844],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await boot(page, theme);
        await boardVideoState(page);
        await shot(page, `${tag}-editor-video-${w}`);
        await page.keyboard.press('ControlOrMeta+e');
        await page.waitForTimeout(800);
        await shot(page, `${tag}-export-video-${w}`);
        if (w === 1440) {
          await page.getByRole('button', { name: /^Download MP4/ }).click();
          await page.getByText('Encoding in a worker. Keep editing.').waitFor();
          await page.waitForTimeout(1200);
          await shot(page, `${tag}-export-video-encoding-${w}`);
          await page.getByRole('button', { name: 'Cancel' }).click();
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await boot(page, theme);
      await openMedia(page, '/samples/torus.png', 'torus.png');
      await page.keyboard.press('ControlOrMeta+e');
      await page.waitForTimeout(800);
      await shot(page, `${tag}-export-1440`);
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.waitForTimeout(600);
      await shot(page, `${tag}-export-1024`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      await shot(page, `${tag}-export-390`);

      // States: aspect warning, custom size, inline failure.
      await page.setViewportSize({ width: 1440, height: 900 });
      await boot(page, theme);
      await store(page, "(s) => s.setParam('columns', 160)");
      await openMedia(page, '/tests/fixtures/waves_600x400.png', 'waves_600x400.png');
      await page.keyboard.press('ControlOrMeta+e');
      await page.getByRole('radio', { name: /^Custom/ }).click();
      await store(page, "(s) => s.setJob({ status: 'error', error: 'At 4× the image would be 20480 × 11520 px, larger than this device can draw (16384 px per side). Use 3× or lower.' })");
      await page.waitForTimeout(800);
      await shot(page, `${tag}-export-states-1440`);
      await store(page, "(s) => s.setJob({ status: 'idle', error: null })");
    });
  }
});
