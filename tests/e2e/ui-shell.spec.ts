import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';
import path from 'node:path';

/**
 * Shell + stage + engine lifecycle in the running app: real files through the controller, the
 * render loop, overlays placed from the engine's layout, and the input model (probe, zoom, pan,
 * split, drop, paste).
 */

const FIXTURES = path.resolve('tests/fixtures');

const store = <T>(page: Page, expr: string) =>
  page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore: s }) => (${expr}))`) as Promise<T>;

/** The drawn grid in page px, read from the frame overlay and the canvas's accessible name. */
async function grid(page: Page) {
  const canvas = page.getByRole('img', { name: /, [1-9]\d* by [1-9]\d* cells$/ });
  await expect(canvas).toBeVisible();
  const [, cols, rows] = /(\d+) by (\d+) cells$/.exec((await canvas.getAttribute('aria-label'))!)!;
  await expect(page.locator('.frm')).toBeVisible();
  const frame = (await page.locator('.frm').boundingBox())!;
  return { ...frame, cols: +cols, rows: +rows };
}

async function ready(page: Page) {
  await page.waitForFunction(`${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().stats.cols > 0)`, null, { timeout: 30_000 });
}

const controller = (page: Page, call: string) => page.evaluate(`${appImport('/src/app/controller.ts')}.then((c) => ${call})`);

async function openSample(page: Page, url = 'samples/torus.png', name = 'torus.png') {
  await controller(page, `c.openSample(${JSON.stringify(url)}, ${JSON.stringify(name)})`);
  await ready(page);
}

/** Through the real picker: "Choose file" on the start screen, "Open" in the editor. */
async function openFixture(page: Page, file: string) {
  const button = page.getByRole('button', { name: /^(Choose file|Open)$/ });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(path.isAbsolute(file) ? file : path.join(FIXTURES, file));
}

/** Page coordinates of the centre of a grid cell. */
async function cellPoint(page: Page, col: number, row: number) {
  const g = await grid(page);
  return { x: g.x + ((col + 0.5) * g.width) / g.cols, y: g.y + ((row + 0.5) * g.height) / g.rows };
}

test.beforeEach(async ({ page }) => {
  await trackAppModules(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
});

test('a still opens with its source chip, a caption from the real geometry and live stats', async ({ page }) => {
  await openSample(page);
  await expect(page.locator('.src-name')).toHaveText('torus.png');
  await expect(page.locator('.src-meta')).toContainText('1280 × 720');
  const cap = page.locator('.cap');
  await expect(cap).toContainText('Source 1280 × 720');
  await expect(cap).toContainText('Output 1280 × 720 px at 1×');
  await expect(cap).toContainText('Aspect locked 16:9');
  await expect(page.getByRole('img', { name: 'ASCII render of torus.png, 160 by 45 cells' })).toBeVisible();
  const status = page.getByRole('contentinfo', { name: 'Status' });
  await expect(status).toContainText('Ready');
  await expect(status).toContainText('160 × 45');
  await expect(status).toContainText('WebGL2');
  // Fitted: the grid is centred in the art area, keeps the source aspect and leaves the 32 px pad.
  const g = await grid(page);
  const area = (await page.locator('.va').boundingBox())!;
  expect(Math.abs(g.x + g.width / 2 - (area.x + area.width / 2))).toBeLessThan(1);
  expect(Math.abs(g.y + g.height / 2 - (area.y + area.height / 2))).toBeLessThan(1);
  expect(Math.abs(g.width / g.height - 16 / 9)).toBeLessThan(0.01);
  expect(Math.min(area.width - g.width, area.height - g.height)).toBeGreaterThanOrEqual(63);
});

test('the probe reads the hovered cell and mirrors it in the status bar', async ({ page }) => {
  await openSample(page);
  const p = await cellPoint(page, 35, 22);
  await page.mouse.move(p.x, p.y);
  const tag = page.locator('.tag');
  await expect(tag).toContainText('C035');
  await expect(tag).toContainText('R22');
  await expect(tag).toContainText(/L \d\.\d\d/);
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('C035 R22');
  // Never over the cell itself.
  const box = (await tag.boundingBox())!;
  expect(box.x + box.width <= p.x - 4 || box.x >= p.x + 4).toBe(true);
  await page.mouse.move(5, 5);
  await expect(tag).toHaveCount(0);
});

test('wheel zooms around the cursor, drag pans, double-click fits', async ({ page }) => {
  await openSample(page);
  const zoom = page.locator('.zoom-v');
  const fitText = await zoom.textContent();
  const p = await cellPoint(page, 100, 20);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('.tag')).toContainText('C100');
  await page.mouse.wheel(0, -300);
  await expect(zoom).not.toHaveText(fitText!);
  // The cell under the cursor did not move.
  await page.mouse.move(p.x + 1, p.y);
  await expect(page.locator('.tag')).toContainText('C100');
  await expect(page.locator('.tag')).toContainText('R20');
  const before = await store<number>(page, 's.getState().view.panX');
  await page.mouse.down();
  await page.mouse.move(p.x - 120, p.y, { steps: 4 });
  await page.mouse.up();
  expect(await store<number>(page, 's.getState().view.panX')).toBeLessThan(before - 100);
  await page.mouse.dblclick(p.x, p.y);
  await expect(zoom).toHaveText(fitText!);
  expect(await store<string>(page, 's.getState().view.zoom')).toBe('fit');
});

test('zoom buttons and keys step, F fits, 1 is actual size', async ({ page }) => {
  await openSample(page);
  const zoom = page.locator('.zoom-v');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).toHaveText('100%');
  await page.locator('body').press('=');
  await expect(zoom).toHaveText('150%');
  await page.locator('body').press('-');
  await expect(zoom).toHaveText('100%');
  await page.locator('body').press('f');
  expect(await store<string>(page, 's.getState().view.zoom')).toBe('fit');
  await page.locator('body').press('1');
  await expect(zoom).toHaveText('100%');
});

test('split compare: the handle is a keyboard slider and the status bar follows it', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Split' }).click();
  const knob = page.getByRole('slider', { name: 'Split position' });
  await expect(knob).toHaveAttribute('aria-valuenow', '50');
  await expect(page.locator('.chip')).toHaveText(['Source', 'Shape']);
  await knob.focus();
  await page.keyboard.press('ArrowRight');
  await expect(knob).toHaveAttribute('aria-valuenow', '51');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(knob).toHaveAttribute('aria-valuenow', '41');
  await page.keyboard.press('End');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('Split 100%');
  // Dragging the handle follows the pointer across the frame.
  const g = await grid(page);
  const k = (await knob.boundingBox())!;
  await page.mouse.move(k.x + 16, k.y + 16);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width * 0.25, k.y + 16, { steps: 5 });
  await page.mouse.up();
  await expect(knob).toHaveAttribute('aria-valuenow', '25');
  await page.locator('body').press('s');
  await expect(knob).toHaveCount(0);
});

test('export swaps rulers for dimension lines and reads zoom against the export size', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('.zoom-v')).toHaveText('100%');
  await page.getByRole('button', { name: /^Export/ }).click();
  await expect(page.getByRole('button', { name: /^Export/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.dim.w')).toHaveText('2560 px');
  await expect(page.locator('.dim.h')).toHaveText('1440 px');
  await expect(page.locator('.zoom-v')).toHaveText('50%');
  await expect(page.locator('.cap')).toContainText('Output 2560 × 1440 px at 2×');
  await expect(page.locator('.cap')).toContainText('Aspect matches source');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('PNG 2560 × 1440 · 2×');
});

test('a GIF and a video play through the engine', async ({ page }) => {
  await openFixture(page, 'transparent_variable_duration.gif');
  await ready(page);
  await expect(page.locator('.src-name')).toHaveText('transparent_variable_duration.gif');
  const status = page.getByRole('contentinfo', { name: 'Status' });
  await expect(status).toContainText('Playing');
  await expect(page.locator('.cap')).toContainText('Source 320 × 240 at 12.5 fps');
  const t0 = await store<number>(page, 's.getState().playback.time');
  await expect.poll(() => store<number>(page, 's.getState().playback.time')).not.toBe(t0);

  await openFixture(page, 'testsrc2_4s.mp4');
  await expect(page.locator('.src-name')).toHaveText('testsrc2_4s.mp4');
  await expect(page.locator('.src-meta')).toContainText('30 fps');
  await expect(status).toContainText('Playing');
  await expect.poll(() => store<number>(page, 's.getState().stats.fps'), { timeout: 5000 }).toBeGreaterThan(5);
});

test('EXIF rotation and alpha sources keep their display size', async ({ page }) => {
  await openFixture(page, 'exif6_480x270.jpg');
  await expect(page.locator('.cap')).toContainText('Source 270 × 480');
  await openFixture(page, 'logo_rgba_256.png');
  await expect(page.locator('.cap')).toContainText('Source 256 × 256');
  await expect(page.locator('.cap')).toContainText('Aspect locked 1:1');
});

test('an unsupported file is a toast, and the last good frame stays', async ({ page }) => {
  await openSample(page);
  await openFixture(page, path.resolve('package.json'));
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('That file type isn’t supported');
  await expect(alert).toContainText('package.json can’t be opened.');
  await expect(page.locator('.src-name')).toHaveText('torus.png');
  expect(await store<string>(page, 's.getState().media.status')).toBe('ready');
});

test('the newest open wins over a slower earlier one', async ({ page }) => {
  await openSample(page);
  await controller(page, `(c.openSample('samples/interference_loop.mp4', 'interference_loop.mp4'), c.openSample('samples/planet.png', 'planet.png'))`);
  await expect(page.locator('.src-name')).toHaveText('planet.png');
  await page.waitForTimeout(1500);
  await expect(page.locator('.src-name')).toHaveText('planet.png');
});

test('dragging a file over the editor shows the replace frame; unsupported drags show nothing', async ({ page }) => {
  await openSample(page);
  const drag = (type: string, event: string) =>
    page.evaluate(
      ([t, e]) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'x', { type: t }));
        window.dispatchEvent(new DragEvent(e, { dataTransfer: dt, bubbles: true }));
      },
      [type, event],
    );
  await drag('image/png', 'dragenter');
  await expect(page.locator('.drop-ov')).toContainText('Drop to replace torus.png');
  await drag('image/png', 'dragleave');
  await expect(page.locator('.drop-ov')).toHaveCount(0);
  await drag('application/pdf', 'dragenter');
  await expect(page.locator('.drop-ov')).toHaveCount(0);
});

test('pasting a link the server will not share explains CORS', async ({ page }) => {
  // An aborted request is what fetch() sees when a server sends no CORS headers: a bare TypeError.
  await page.route('https://cors-refused.test/**', (route) => route.abort('accessdenied'));
  await openSample(page);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://cors-refused.test/cat.png');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('cors-refused.test');
  await expect(alert).toContainText('blocks other sites');
  await expect(page.locator('.src-name')).toHaveText('torus.png');
});

test('Back asks first: Cancel and Esc stay (focus back on Back), Enter or Close file returns to the start screen', async ({ page }) => {
  await openSample(page);
  const back = page.getByRole('button', { name: 'Back to start screen' });
  const dialog = page.getByRole('alertdialog', { name: 'Return to the start screen?' });
  await back.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/^Your current settings are saved in this browser/);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();

  await back.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
  expect(await store<string>(page, 's.getState().media.status')).toBe('ready');

  // The wordmark asks the same; Enter confirms. Settings survive the close.
  await store(page, "s.getState().setParam('contrast', 1.4)");
  await page.getByRole('link', { name: 'ASCII Renderer home' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.src-name')).toHaveCount(0);
  expect(await store<string>(page, 's.getState().media.status')).toBe('empty');
  expect(await store<number>(page, 's.getState().params.contrast')).toBe(1.4);

  await openSample(page);
  await back.click();
  await dialog.getByRole('button', { name: 'Close file' }).click();
  await expect(page.locator('.src-name')).toHaveCount(0);
});

test('phone: a 16:9 preview with a one-line readout, no rulers or caption', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page);
  await expect(page.locator('.pstat')).toContainText('Grid 160 × 45');
  await expect(page.locator('.cap')).toHaveCount(0);
  const va = (await page.locator('.va').boundingBox())!;
  expect(Math.round(va.width)).toBe(358);
  expect(Math.abs(va.height - (358 * 9) / 16)).toBeLessThan(1);
});
