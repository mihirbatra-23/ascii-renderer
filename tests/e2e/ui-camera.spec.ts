import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';

/** The camera as a live source, with Chrome's fake camera (no permission prompt, a test pattern). */

test.use({
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera'],
});

test.beforeEach(({ page }) => trackAppModules(page));

const store = <T>(page: Page, expr: string) => page.evaluate(`__appImport('/src/state/store.ts').then(({ useStore: s }) => (${expr}))`) as Promise<T>;

async function boot(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
}

async function ready(page: Page) {
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`, null, {
    timeout: 30_000,
  });
  // The store is ready a moment before React has mounted the editor.
  await page.locator('.app').waitFor();
}

test('the camera opens live from the start screen, plays and pauses, and stops on close', async ({ page }) => {
  await boot(page);
  await page.getByRole('region', { name: 'Open a file' }).getByRole('button', { name: 'Camera' }).click();
  await ready(page);
  await expect(page.locator('.src .live-badge')).toHaveText('Live');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('Live');
  // Only play / pause: no timeline, trim or speed for a live source.
  const transport = page.getByRole('group', { name: 'Camera' });
  await expect(transport.getByRole('button', { name: 'Freeze frame' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Timeline' })).toHaveCount(0);
  expect(await store<boolean>(page, 's.getState().media.info.live')).toBe(true);
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        void __appImport('/src/app/runtime.ts').then(({ runtime }) => {
          let n = 0;
          const off = runtime.get().player!.onFrame(() => n++);
          setTimeout(() => {
            off();
            resolve(n);
          }, 1000);
        });
      }),
  );
  expect(frames).toBeGreaterThan(5);
  await transport.getByRole('button', { name: 'Freeze frame' }).click();
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('Paused');
  const track = await page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const media = runtime.get().media as { element: HTMLVideoElement };
    (window as unknown as { __stream: MediaStream }).__stream = media.element.srcObject as MediaStream;
    return true;
  });
  expect(track).toBe(true);
  await page.getByRole('button', { name: 'Back to start screen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop camera' }).click();
  await expect(page.getByRole('region', { name: 'Open a file' })).toBeVisible();
  const states = await page.evaluate(() => (window as unknown as { __stream: MediaStream }).__stream.getTracks().map((t) => t.readyState));
  expect(states).toEqual(['ended']);
});
