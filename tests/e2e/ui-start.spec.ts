import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';

/** Start screen, Shortcuts sheet and theme switch (src/ui/start, src/ui/shell). */

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

test('URL field: Enter on an empty field keeps focus there; a bad address explains itself', async ({ page }) => {
  const field = page.getByRole('textbox', { name: 'Image or video URL' });
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(field).toBeFocused();
  await field.fill('not a url');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('That isn’t a web address');
});

test('? opens the Shortcuts sheet from the registry; Escape closes it', async ({ page }) => {
  await page.keyboard.press('Shift+Slash');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  for (const group of ['File', 'Edit', 'View', 'General', 'Render', 'Playback', 'Start']) {
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

test('theme switch: Carbon sets data-theme="b" and survives a reload', async ({ page }) => {
  const footer = page.locator('footer.sfoot');
  await footer.getByRole('radio', { name: 'Carbon' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'b');
  await expect(footer.getByRole('radio', { name: 'Carbon' })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(600); // persistence is debounced
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'b');
  // Arrow keys move the radiogroup selection back to Graphite.
  await page.locator('footer.sfoot').getByRole('radio', { name: 'Carbon' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'b');
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
});
