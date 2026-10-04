import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';

/**
 * Export for a live camera (Chrome's fake camera): still formats save the frame on show, MP4 / WebM
 * are recorded in real time (Record, elapsed time, Stop and save or Discard), and GIF is not offered.
 */

test.use({
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera'],
});

test.beforeEach(async ({ page }) => {
  await trackAppModules(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(`${appImport('/src/app/controller.ts')}.then((c) => c.openCamera())`);
  await page.waitForFunction(
    `${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`,
    null,
    { timeout: 30_000 },
  );
});

const exportDock = (page: Page) => page.getByRole('complementary', { name: 'Export' });

test('a camera records MP4 until stopped, with the elapsed time, and saves it', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+e');
  const dock = exportDock(page);
  const motion = dock.getByRole('radiogroup', { name: 'Motion formats' });
  await expect(motion.getByRole('radio', { name: /^GIF/ })).toBeDisabled();
  const mp4 = motion.getByRole('radio', { name: /^MP4/ });
  await expect(mp4).toHaveAttribute('aria-checked', 'true');
  await expect(mp4).toContainText('Record');
  await expect(dock.getByText('A camera records in real time, as MP4 or WebM, until you stop it.')).toBeVisible();

  await dock.getByRole('button', { name: /^Record MP4/ }).click();
  const stop = dock.getByRole('button', { name: /^Stop and save MP4/ });
  await expect(stop).toBeFocused();
  await expect(dock.getByRole('timer')).toHaveText('00:01', { timeout: 5_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.keyboard.press('ControlOrMeta+Enter')]);
  const bytes = readFileSync(await download.path());
  // MP4 ('ftyp') where the browser records it, else WebM (EBML) with the extension saying so.
  if (download.suggestedFilename().endsWith('.mp4')) expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  else expect(bytes.readUInt32BE(0)).toBe(0x1a45dfa3);
  await expect(dock.getByRole('button', { name: /^Record MP4/ })).toBeFocused();
});

test('Discard throws a recording away', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+e');
  const dock = exportDock(page);
  await dock.getByRole('button', { name: /^Record MP4/ }).click();
  await dock.getByRole('button', { name: 'Discard' }).click();
  await expect(dock.getByRole('button', { name: /^Record MP4/ })).toBeVisible();
  expect(await page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().job.status)`)).toBe('idle');
});

test('a still format saves the frame on show', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+e');
  const dock = exportDock(page);
  await dock.getByRole('radio', { name: /^PNG/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), dock.getByRole('button', { name: /^Download PNG/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
});
