import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';

/** The stage's use of the engine: the cursor probe, the render-time readout, the source on close. */

test.beforeEach(({ page }) => trackAppModules(page));

async function openTorus(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.keyboard.press('1');
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`, null, {
    timeout: 30_000,
  });
  await page.locator('.app').waitFor();
}

/** Counts calls to an engine method from now on. */
async function countCalls(page: Page, method: string) {
  await page.evaluate(async (method) => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const engine = runtime.get().engine as Record<string, (...args: unknown[]) => unknown>;
    const original = engine[method].bind(engine);
    const w = window as unknown as Record<string, number>;
    w[`__calls_${method}`] = 0;
    engine[method] = (...args: unknown[]) => {
      w[`__calls_${method}`]++;
      return original(...args);
    };
  }, method);
  return () => page.evaluate((method) => (window as unknown as Record<string, number>)[`__calls_${method}`], method);
}

test('the probe follows the cursor and edits without reading the whole grid back', async ({ page }) => {
  await openTorus(page);
  const snapshots = await countCalls(page, 'snapshot');
  const frame = (await page.locator('.frm').boundingBox())!;
  // Cell 40, 20 of the 160 × 45 grid.
  await page.mouse.move(frame.x + (40.5 * frame.width) / 160, frame.y + (20.5 * frame.height) / 45);
  const tag = page.locator('.tag');
  await expect(tag).toContainText('C040');
  await expect(tag).toContainText('R20');
  for (let i = 0; i < 4; i++) await page.keyboard.press('i');
  await page.mouse.move(frame.x + (41.5 * frame.width) / 160, frame.y + (20.5 * frame.height) / 45);
  await expect(tag).toContainText('C041');
  expect(await snapshots()).toBe(0);
});

test('Render is measured on real frames and stays meaningful after an edit', async ({ page }) => {
  await openTorus(page);
  const render = page.getByRole('contentinfo', { name: 'Status' }).locator('.it', { hasText: 'Render' });
  await expect(render).toHaveAttribute('title', /GPU time|main thread/);
  const read = async () => Number(/([\d.]+) ms/.exec((await render.textContent()) ?? '')?.[1] ?? 0);
  await expect.poll(read).toBeGreaterThan(0.1);
  // An edit used to read '<0.1 ms' (only the CPU submit was timed).
  await page.keyboard.press('i');
  await page.waitForTimeout(600);
  expect(await read()).toBeGreaterThan(0.1);
});

test('closing frees the engine’s copy of the source', async ({ page }) => {
  await openTorus(page);
  const releases = await countCalls(page, 'releaseSource');
  await page.getByRole('button', { name: 'Close torus.png' }).click();
  await expect(page.getByRole('region', { name: 'Open a file' })).toBeVisible();
  expect(await releases()).toBe(1);
  const grid = await page.evaluate(async () => (await __appImport('/src/app/runtime.ts')).runtime.get().engine.getGrid());
  expect(grid).toEqual({ cols: 0, rows: 0 });
});

test('Export’s transparent background shows as a checker under the preview', async ({ page }) => {
  await openTorus(page);
  await page.getByRole('button', { name: /^Export/ }).first().click();
  const checker = page.locator('.va .chk');
  await expect(checker).toHaveCount(0);
  await page.getByText('Transparent background').click();
  await expect(checker).toBeVisible();
  // Under the canvas, over the grid rect.
  expect(await page.locator('.va > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['chk', 'va-canvas', 'frm']);
  const [chk, frm] = [(await checker.boundingBox())!, (await page.locator('.frm').boundingBox())!];
  expect(chk).toEqual(frm);
  await expect
    .poll(() => page.evaluate(async () => (await __appImport('/src/app/engineHost.ts')).getStageLayout()?.viewport.transparentBackground))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(checker).toHaveCount(0);
});
