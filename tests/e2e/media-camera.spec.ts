import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Live camera sources (src/media/camera.ts) and real-time recording (src/export/recorder.ts), with
 * Chrome's fake camera: a test pattern, no prompt once the permission is granted.
 */
test.use({
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream'] },
  permissions: ['camera'],
});

const SAMPLES = process.env.EXPORT_SAMPLES_DIR;

async function openHarness(page: Page, path: '/dev/media.html' | '/dev/export.html'): Promise<void> {
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window.harness || window.exportHarness));
}

test('openCamera: a live LoadedVideo; the player plays and pauses only; dispose waits for retains, then stops the camera', async ({ page }) => {
  await openHarness(page, '/dev/media.html');
  const r = await page.evaluate(() => window.harness.cameraPlayer());
  expect(r).toMatchObject({ kind: 'video', live: true, durationSec: Infinity, playerDuration: Infinity, frameTimes: null, playing: true, pausedAfterStep: true });
  expect(r.width).toBeGreaterThan(0);
  expect(r.afterSeek, 'seek(0) shows the current picture').toBeGreaterThanOrEqual(1);
  expect(r.whilePlaying - r.afterSeek, 'frames while playing').toBeGreaterThan(5);
  expect(r.timeUnchangedByStep).toBe(true);
  expect(r.trim, 'trim is ignored for live sources').toEqual([0, Infinity]);
  expect(r.liveWhileRetained).toBe(true);
  expect(r.stoppedAfterRelease).toBe(true);
});

test('openCamera without permission fails with a camera-blocked MediaError written for people', async ({ browser }) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await openHarness(page, '/dev/media.html');
  const r = await page.evaluate(() => window.harness.cameraError());
  expect(r?.code).toBe('camera-blocked');
  expect(r?.message).toMatch(/Allow the camera for this site/);
  await context.close();
});

for (const format of ['webm', 'mp4'] as const) {
  test(`records the live camera through the engine in real time (${format})`, async ({ page }) => {
    await openHarness(page, '/dev/export.html');
    const r = await page.evaluate((f) => window.exportHarness.record({ ms: 1600, format: f, scale: 1 }), format);
    console.log('recording', JSON.stringify({ ...r, base64: undefined, probe: { ...r.probe, thumbnails: undefined, timestamps: undefined } }));
    expect(r.camera.live).toBe(true);
    expect(r.camera.durationSec).toBe(Infinity);
    expect(r.midway[0].state).toBe('recording');
    expect(r.midway[0].elapsedSec).toBeGreaterThan(0.5);
    expect(r.after.state).toBe('stopped');
    expect(r.after.elapsedSec).toBeGreaterThan(1.4);
    expect(r.after.frames).toBeGreaterThan(10);
    expect(r.plannedSize.width % 2).toBe(0);
    expect(r.plannedSize.height % 2).toBe(0);
    expect({ width: r.probe.width, height: r.probe.height }).toEqual(r.plannedSize);
    expect(r.probe.decoded).toBeGreaterThan(10);
    expect(r.result.fileName).toMatch(new RegExp(`^camera-ascii-60x\\d+\\.${r.container}$`));
    // The recording holds the camera only while it runs; dispose then stops it.
    expect(r.tracksBefore).toEqual(['live']);
    expect(r.tracksAfterDispose).toEqual(['ended']);
    if (SAMPLES) {
      mkdirSync(SAMPLES, { recursive: true });
      writeFileSync(join(SAMPLES, `camera.${r.container}`), Buffer.from(r.base64, 'base64'));
    }
  });
}

test('records at an exact width: the file is that wide (padded to even), the grid keeps its aspect', async ({ page }) => {
  await openHarness(page, '/dev/export.html');
  const r = await page.evaluate(() => window.exportHarness.record({ ms: 800, format: 'webm', targetWidth: 333 }));
  expect(r.plannedSize.width).toBe(334);
  expect({ width: r.probe.width, height: r.probe.height }).toEqual(r.plannedSize);
  expect(r.after.frames).toBeGreaterThan(5);
});
