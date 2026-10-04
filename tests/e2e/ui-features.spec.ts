import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';

/** Settings links, Split against a Ramp render, and the editor's Open menu. */

test.beforeEach(({ page }) => trackAppModules(page));

const store = <T>(page: Page, expr: string) => page.evaluate(`__appImport('/src/state/store.ts').then(({ useStore: s }) => (${expr}))`) as Promise<T>;

async function boot(page: Page, hash = '') {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/${hash}`);
  await page.getByRole('heading', { level: 1 }).waitFor();
}

async function ready(page: Page) {
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`, null, {
    timeout: 30_000,
  });
  // The store is ready a moment before React has mounted the editor.
  await page.locator('.app').waitFor();
}

const payload = (p: Record<string, unknown>) => Buffer.from(JSON.stringify({ v: 1, p })).toString('base64url');

test.describe('settings links', () => {
  test('a link opens with its settings, wins over stored ones, and leaves a clean address', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('ascii-renderer:v1', JSON.stringify({ params: { columns: 300, contrast: 1.9 } })));
    await page.goto(`/#s=${payload({ mode: 'braille', columns: 120, edges: true })}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await store(page, '({ mode: s.getState().params.mode, columns: s.getState().params.columns, contrast: s.getState().params.contrast, edges: s.getState().params.edges })')).toEqual({
      mode: 'braille',
      columns: 120,
      contrast: 1,
      edges: true,
    });
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a link pasted into an open tab applies as one undoable change', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('1');
    await ready(page);
    const before = await store<number>(page, 's.getState().params.columns');
    await page.evaluate((hash) => (location.hash = hash), `#s=${payload({ columns: 77 })}`);
    await expect.poll(() => store<number>(page, 's.getState().params.columns')).toBe(77);
    await expect(page.locator('.toast').filter({ hasText: 'Applied settings from the link' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    expect(await store<number>(page, 's.getState().params.columns')).toBe(before);
  });

  // the recipient is told the look is ready, and a sample opens in the link's look
  // rather than replacing it with its own.
  test('arriving by a link says so, and a sample then opens in the link’s look', async ({ page }) => {
    await boot(page, `#s=${payload({ mode: 'braille', contrast: 1.5, colorMode: 'mono', invert: true })}`);
    await expect(page.locator('.toast').filter({ hasText: 'Settings from the link are ready' })).toBeVisible();
    await expect(page.locator('.sr.toast-live[role="status"]')).toContainText('Settings from the link are ready');
    await page.keyboard.press('1');
    await ready(page);
    expect(await store(page, '({ mode: s.getState().params.mode, contrast: s.getState().params.contrast, invert: s.getState().params.invert })')).toEqual({
      mode: 'braille',
      contrast: 1.5,
      invert: true,
    });
  });

  test('a sample replacing settings the user changed says so and can be undone', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => __appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().setParams({ mode: 'blocks', contrast: 1.7 })));
    await page.keyboard.press('1');
    await ready(page);
    expect(await store<string>(page, 's.getState().params.mode')).toBe('shape');
    const notice = page.locator('.toast').filter({ hasText: 'Applied settings from torus.png' });
    await notice.getByRole('button', { name: 'Undo' }).click();
    expect(await store(page, '({ mode: s.getState().params.mode, contrast: s.getState().params.contrast })')).toEqual({ mode: 'blocks', contrast: 1.7 });
  });

  test('a broken link changes nothing and says so', async ({ page }) => {
    await boot(page, '#s=AAAA');
    await expect(page.locator('.toast').filter({ hasText: 'That settings link can’t be read' })).toBeVisible();
    expect(await store<string>(page, 's.getState().params.mode')).toBe('shape');
  });

  test('copySettingsLink copies a link that reproduces the look', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await page.keyboard.press('1');
    await ready(page);
    await page.keyboard.press('m');
    await page.evaluate(() => __appImport('/src/app/permalink.ts').then((m) => m.copySettingsLink()));
    await expect(page.locator('.toast').filter({ hasText: 'Settings link copied' })).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/#s=[A-Za-z0-9_-]+$/);
    const mode = await store<string>(page, 's.getState().params.mode');
    await page.evaluate(() => localStorage.clear());
    await page.goto(link);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await store<string>(page, 's.getState().params.mode')).toBe(mode);
  });
});

// the toast's timer lived in its card, so going home and opening another file restarted its 5 s.
test('a toast keeps its own clock when the screen changes underneath it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.keyboard.press('1');
  await ready(page);
  const shownAt = await page.evaluate(async () => {
    await __appImport('/src/app/permalink.ts').then((m) => m.copySettingsLink());
    return performance.now();
  });
  const notice = page.locator('.toast').filter({ hasText: 'Settings link copied' });
  await expect(notice).toBeVisible();
  await page.waitForTimeout(2500);
  await page.evaluate(() => __appImport('/src/app/controller.ts').then((c) => c.closeMedia()));
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.keyboard.press('3');
  await ready(page);
  await expect(notice).toBeHidden({ timeout: 6000 });
  const goneAt = await page.evaluate(() => performance.now());
  expect(goneAt - shownAt).toBeLessThan(6500);
});

test('Split compares with the source or a Ramp render, and the chips say which', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('1');
  await ready(page);
  await page.keyboard.press('s');
  // The accessible name starts with the visible text (WCAG 2.5.3 label in name).
  const menu = page.getByRole('button', { name: /^vs Source/ });
  await expect(menu).toHaveText(/vs Source/);
  await expect(page.locator('.split .chip.l')).toHaveText('Source');
  await menu.click();
  await page.getByRole('menuitemradio', { name: /^Ramp/ }).click();
  const rampMenu = page.getByRole('button', { name: /^vs Ramp/ });
  await expect(rampMenu).toHaveText(/vs Ramp/);
  await expect(page.locator('.split .chip.l')).toHaveText('Ramp');
  await expect(page.locator('.split .chip.r')).toHaveText('Shape');
  expect(await store<string>(page, 's.getState().view.compareWith')).toBe('ramp');
  // Ramp against Ramp with contour lines on: the right chip names what the left lacks.
  await page.evaluate(() => __appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().setParams({ mode: 'ramp', edges: true })));
  await expect(page.locator('.split .chip.r')).toHaveText('Ramp + contour lines');
  await expect
    .poll(() => page.evaluate(() => __appImport('/src/app/engineHost.ts').then((h) => h.getStageLayout()?.viewport.compareWith)))
    .toBe('ramp');
  // without contour lines a Ramp render is the output itself, so the split shows the source
  // and the menu says why Ramp is unavailable (the choice is kept for later).
  await page.evaluate(() => __appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().setParams({ edges: false })));
  await expect(page.locator('.split .chip.l')).toHaveText('Source');
  await expect(page.locator('.split .chip.r')).toHaveText('Ramp');
  await expect
    .poll(() => page.evaluate(() => __appImport('/src/app/engineHost.ts').then((h) => h.getStageLayout()?.viewport.compareWith)))
    .toBe('source');
  await menu.click();
  const rampItem = page.getByRole('menuitemradio', { name: /^Ramp/ });
  await expect(rampItem).toHaveAttribute('aria-disabled', 'true');
  await expect(rampItem).toHaveAccessibleDescription(/Same as the output/);
  await page.keyboard.press('Escape');
  expect(await store<string>(page, 's.getState().view.compareWith')).toBe('ramp');
  // Leaving Split hides the choice; it is remembered for the next Split.
  await page.keyboard.press('s');
  await expect(menu).toHaveCount(0);
});

test('the editor’s Open button keeps one-click picking and lists the other ways in', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('1');
  await ready(page);
  await page.getByRole('button', { name: 'More ways to open' }).click();
  await expect(page.getByRole('menuitem', { name: /Choose file…/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Paste/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Camera/ })).toBeVisible();
  await page.keyboard.press('Escape');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Open', exact: true }).click()]);
  expect(chooser).toBeTruthy();
});
