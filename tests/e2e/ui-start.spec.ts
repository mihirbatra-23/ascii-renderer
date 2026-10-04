import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';

/** Start screen and Shortcuts sheet (src/ui/start, src/ui/shell). */

const storeEval = <T>(page: Page, body: string) =>
  page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore: s }) => { ${body} })`) as Promise<T>;

async function drag(page: Page, event: 'dragenter' | 'dragleave', type: string) {
  await page.evaluate(
    ([e, t]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'file', { type: t }));
      window.dispatchEvent(new DragEvent(e, { dataTransfer: dt, bubbles: true }));
    },
    [event, type],
  );
}

/** Waits for React to mount and register the start screen's shortcuts. */
async function openStart(page: Page) {
  await page.goto('/');
  await expect(page.locator('.tiles .tile')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
}

test.beforeEach(async ({ page }) => {
  await trackAppModules(page);
  await openStart(page);
});

test('start screen: headline, drop zone actions and three real sample renders', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Images, GIFs and video,\s*rendered in type\./);
  const zone = page.getByRole('region', { name: 'Open a file' });
  await expect(zone.getByRole('button', { name: /Choose file/ })).toBeVisible();
  await expect(zone.getByRole('button', { name: /Paste/ })).toBeVisible();
  await expect(zone.getByRole('textbox', { name: 'Image or video URL' })).toBeVisible();
  // One ruler numeral every 10 columns, none cut off at the right edge.
  await expect(zone.locator('.dz-r span')).toHaveCount(16);

  const tiles = page.locator('.tiles .tile');
  await expect(tiles).toHaveCount(3);
  await expect(page.locator('.tile .art[data-ready]')).toHaveCount(3, { timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    const lines = (await tiles.nth(i).locator('.art').innerText()).replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.length === 72)).toBe(true);
    expect(lines.join('').replace(/\s/g, '').length).toBeGreaterThan(150);
  }
  await expect(tiles.nth(1)).toHaveAccessibleName('Open sample interference_loop.mp4, Ramp · 4.0 s');
});

test('keys 1–3 open a sample in the look its tile shows', async ({ page }) => {
  await page.keyboard.press('2');
  expect(await storeEval<string>(page, 'return s.getState().params.mode')).toBe('ramp');
  // Opening a sample leaves the start screen once media loads, so start over for the next key.
  await openStart(page);
  await page.keyboard.press('1');
  expect(await storeEval<string>(page, 'return s.getState().params.mode')).toBe('shape');
  expect(await storeEval<number>(page, 'return s.getState().params.edgeSharpness')).toBe(2.2);
});

test('drag-over: accent edge and "Release to open" only for supported files', async ({ page }) => {
  const zone = page.locator('.dz');
  await drag(page, 'dragenter', 'application/pdf');
  await expect(zone).not.toHaveClass(/over/);
  await drag(page, 'dragleave', 'application/pdf');

  await drag(page, 'dragenter', 'image/gif');
  await expect(zone).toHaveClass(/over/);
  await expect(zone.getByRole('heading', { level: 2 })).toHaveText('Release to open the GIF', { useInnerText: true });
  await drag(page, 'dragleave', 'image/gif');
  await expect(zone).not.toHaveClass(/over/);
  await expect(zone.getByRole('heading', { level: 2 })).toHaveText('Drop an image, GIF or video', { useInnerText: true });
});

test('URL field: Load waits for an address; Enter on an empty field keeps focus there; a bad address explains itself', async ({ page }) => {
  const field = page.getByRole('textbox', { name: 'Image or video URL' });
  const load = page.getByRole('button', { name: 'Load' });
  await expect(load).toBeDisabled();
  // Load is its own button beside the field, the same height and top edge.
  const [f, b] = [(await field.locator('..').boundingBox())!, (await load.boundingBox())!];
  expect(b.x).toBeGreaterThan(f.x + f.width);
  expect(b.height).toBe(f.height);
  expect(b.y).toBe(f.y);
  await field.focus();
  await field.press('Enter');
  await expect(field).toBeFocused();
  await field.fill('not a url');
  await expect(load).toBeEnabled();
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('That isn’t a web address');
});

test('? opens the Shortcuts sheet from the registry; Escape closes it', async ({ page }) => {
  await page.keyboard.press('Shift+Slash');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  for (const group of ['File', 'Edit', 'View', 'General', 'Render', 'Playback', 'Start screen']) {
    await expect(sheet.getByRole('heading', { name: group, exact: true })).toBeVisible();
  }
  const sampleRow = sheet.locator('.kb-row', { hasText: 'Open a sample' });
  await expect(sampleRow.locator('kbd')).toHaveText(['1', '2', '3']);
  // Shift variants are folded into the label ("Shift: 10"), not listed twice.
  await expect(sheet.locator('.kb-row', { hasText: 'Fewer columns' }).locator('kbd')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await storeEval<boolean>(page, 'return s.getState().ui.shortcutsOpen')).toBe(false);

  await page.getByRole('button', { name: /Shortcuts/ }).click();
  await expect(sheet).toBeVisible();
});

test('footer: version and privacy line only; the header and footer stay put while the page scrolls', async ({ page }) => {
  const footer = page.locator('footer.sfoot');
  await expect(footer).toHaveText(/^ASCII Renderer v\d+\.\d+\.\d+\s*Files stay on your device$/);
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'GitHub repository (opens in a new tab)' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  expect((await page.locator('.spg > .top').boundingBox())!.y).toBeCloseTo(0, 0);
  const f = (await footer.boundingBox())!;
  expect(f.y + f.height).toBeCloseTo(600, 0);
});

test('a Carbon theme stored by an older build is ignored', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('ascii-renderer:v1', JSON.stringify({ theme: 'b', params: { ink: '#e4e7e8', shadowInk: '#6d7274', paper: '#0a0b0b', contrast: 1.4 } })),
  );
  await openStart(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  const params = await storeEval<{ ink: string; paper: string; contrast: number }>(page, 'return s.getState().params');
  expect(params).toMatchObject({ ink: '#e6e4df', paper: '#0b0b0c', contrast: 1.4 });
});

test('phone: stacked layout, "Open" title, full-width actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const zone = page.locator('.dz');
  await expect(zone.getByRole('heading', { level: 2 })).toHaveText('Open an image, GIF or video', { useInnerText: true });
  const choose = zone.getByRole('button', { name: /Choose file/ });
  const box = (await choose.boundingBox())!;
  expect(box.width).toBeGreaterThan(300);
  await expect(page.locator('.dz-r')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The GitHub icon button and the one-line 40 px footer stay on phones.
  await expect(page.getByRole('link', { name: 'GitHub repository (opens in a new tab)' })).toBeVisible();
  const foot = (await page.locator('footer.sfoot').boundingBox())!;
  expect(foot.height).toBe(40);
  expect(foot.y + foot.height).toBe(844);
});
