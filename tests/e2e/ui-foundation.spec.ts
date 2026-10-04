import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';

/** Behaviour of the kit (dev/kit.html live controls) and of the store / shortcut foundation. */

const store = (page: Page, js: string) =>
  page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore: s }) => { ${js} })`);

// Before any navigation, so every module the app loads can be found (./appModules).
test.beforeEach(({ page }) => trackAppModules(page));

test.describe('kit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/kit.html');
    await page.evaluate(() => document.fonts.ready);
  });

  test('slider: click jumps, arrows step 1%, Backspace resets, label double-click resets', async ({ page }) => {
    const value = page.getByLabel('Contrast value');
    await expect(value).toHaveValue('1.20');
    const track = page.locator('.row', { has: page.getByText('Contrast', { exact: true }) }).locator('.trk');
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;
    // Dragging past the end clamps to the maximum.
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
    await page.mouse.up();
    await expect(value).toHaveValue('2.00');
    // 1% of the 0.5–2 range is 0.015, snapped to the 0.01 grid.
    await page.keyboard.press('ArrowLeft');
    await expect(value).toHaveValue('1.99');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(value).toHaveValue('1.84');
    await page.keyboard.press('Backspace');
    await expect(value).toHaveValue('1.00');
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
    await page.getByText('Contrast', { exact: true }).dblclick();
    await expect(value).toHaveValue('1.00');
  });

  test('slider drag shows the accent state and the range follows the pointer', async ({ page }) => {
    const track = page.locator('.slider-hero .trk');
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 16);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 16, { steps: 4 });
    await expect(track).toHaveClass(/is-drag/);
    await expect(page.locator('html')).toHaveAttribute('data-adjusting', 'drag');
    await page.mouse.up();
    await expect(track).not.toHaveClass(/is-drag/);
    await expect(page.getByLabel('Columns value')).toHaveValue('220');
  });

  test('value field: scrub, type + Enter, Escape reverts, invalid input reverts', async ({ page }) => {
    const field = page.getByLabel('Columns value');
    await field.scrollIntoViewIfNeeded();
    const box = (await field.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 16);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 16, { steps: 5 });
    await page.mouse.up();
    await expect(field).toHaveValue('196');
    await expect(field).not.toBeFocused();

    await field.click();
    await expect(field).toBeFocused();
    await page.keyboard.type('250');
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('250');
    await page.keyboard.type('999');
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('400');
    await page.keyboard.type('abc');
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('400');
    await page.keyboard.type('nope');
    await page.keyboard.press('Tab');
    await expect(field).toHaveValue('400');
  });

  test('radiogroups: arrow keys move and select with one tab stop', async ({ page }) => {
    const group = page.getByRole('radiogroup', { name: 'Color mode' });
    await group.getByRole('radio', { name: 'Duotone' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'Mono' })).toHaveAttribute('aria-checked', 'true');
    await expect(group.getByRole('radio', { name: 'Mono' })).toBeFocused();
    await expect(group.locator('[tabindex="0"]')).toHaveCount(1);

    const modes = page.getByRole('radiogroup', { name: 'Render mode' }).last();
    await modes.getByRole('radio', { name: 'Shape' }).focus();
    await page.keyboard.press('End');
    await expect(modes.getByRole('radio', { name: 'Blocks' })).toHaveAttribute('aria-checked', 'true');
  });

  test('select: opens with the keyboard, arrows + Enter choose, focus returns', async ({ page }) => {
    const trigger = page.getByRole('region', { name: 'Glyphs' }).getByRole('button', { name: 'Character set: Full ASCII' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const list = page.locator('.popover').getByRole('listbox', { name: 'Character set' });
    await expect(list).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Character set: Minimal' })).toBeFocused();
  });

  test('menu button and dialog', async ({ page }) => {
    await page.getByRole('button', { name: 'Presets' }).click();
    await expect(page.getByRole('menuitem', { name: 'Crisp lines' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('button', { name: 'Shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  });
});

test.describe('store and shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await store(page, `s.getState().setMedia({ status: 'ready', info: { name: 't.png', kind: 'image', width: 1280, height: 720, fileSize: 1, formatLabel: 'PNG' } })`);
  });

  test('a drag is one undo entry; undo / redo via shortcuts', async ({ page }) => {
    await store(page, `const g = s.getState(); [0.6, 0.7, 0.8].forEach((v) => g.setParam('gamma', v, { commit: false })); g.commitParams();`);
    expect(await page.evaluate(`${appImport('/src/state/store.ts')}.then(m => m.useStore.getState().history.past.length)`)).toBe(1);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await page.evaluate(`${appImport('/src/state/store.ts')}.then(m => m.useStore.getState().params.gamma)`)).toBe(1);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await page.evaluate(`${appImport('/src/state/store.ts')}.then(m => m.useStore.getState().params.gamma)`)).toBe(0.8);
  });

  test('render keys: M cycles mode, [ ] columns, ? opens shortcuts, ⌘E toggles export, Esc closes', async ({ page }) => {
    const get = (path: string) => page.evaluate(`${appImport('/src/state/store.ts')}.then(m => m.useStore.getState().${path})`);
    await page.keyboard.press('m');
    expect(await get('params.mode')).toBe('ramp');
    await page.keyboard.press(']');
    await page.keyboard.press('Shift+BracketRight');
    expect(await get('params.columns')).toBe(171);
    await page.keyboard.press('ControlOrMeta+e');
    expect(await get('exportUi.open')).toBe(true);
    await page.keyboard.press('Escape');
    expect(await get('exportUi.open')).toBe(false);
    await page.keyboard.press('?');
    expect(await get('ui.shortcutsOpen')).toBe(true);
  });

  test('params and theme persist across reloads', async ({ page }) => {
    await store(page, `s.getState().setParam('contrast', 1.4); s.getState().setTheme('b');`);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'b');
    expect(await page.evaluate(`${appImport('/src/state/store.ts')}.then(m => m.useStore.getState().params.contrast)`)).toBe(1.4);
  });
});

/**
 * Pointer gestures on the real dock (src/ui/kit/Slider.tsx, useScrub.ts, gesture.ts): on a phone a
 * vertical swipe that starts on a slider must scroll the sheet, never change the value;
 * a gesture the browser takes over (pointercancel) is undone; a drag back to the start value lands
 * on it.
 */
const IMAGE_INFO = `{ name: 't.png', kind: 'image', width: 1280, height: 720, fileSize: 1, formatLabel: 'PNG' }`;
const read = (page: Page, path: string) => page.evaluate(`${appImport('/src/state/store.ts')}.then((m) => m.useStore.getState().${path})`);

async function editor(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await store(page, `s.getState().setMedia({ status: 'ready', info: ${IMAGE_INFO} })`);
  await page.evaluate(() => document.fonts.ready);
}

test.describe('touch on the phone sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= 12; i++) {
      const point = { x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('a vertical swipe that starts on a slider scrolls the sheet and leaves the value', async ({ page }) => {
    await editor(page);
    const body = page.locator('aside.dock .db');
    const row = body.locator('.row', { has: page.getByText('Gamma', { exact: true }) });
    const field = page.getByLabel('Gamma value');
    await expect(field).toHaveValue('1.00');
    for (const part of [row.locator('.trk'), row.locator('label'), field]) {
      await body.evaluate((el) => (el.scrollTop = 0));
      const box = (await part.boundingBox())!;
      const start = { x: box.x + box.width * 0.85, y: box.y + box.height / 2 };
      // A little sideways drift, as a real thumb has.
      await swipe(page, start, { x: start.x + 12, y: start.y - 150 });
      await expect(field).toHaveValue('1.00');
      expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    }
    expect(await read(page, 'history.past.length')).toBe(0);
  });

  test('a sideways drag on the track adjusts, and a tap jumps', async ({ page }) => {
    await editor(page);
    const track = page.locator('aside.dock .row', { has: page.getByText('Gamma', { exact: true }) }).locator('.trk');
    const field = page.getByLabel('Gamma value');
    const box = (await track.boundingBox())!;
    const y = box.y + box.height / 2;
    await swipe(page, { x: box.x + box.width * 0.3, y }, { x: box.x + box.width * 0.9, y: y + 4 });
    expect(Number(await field.inputValue())).toBeGreaterThan(2);
    expect(await read(page, 'history.past.length')).toBe(1);
    await page.touchscreen.tap(box.x + box.width * 0.1, y);
    expect(Number(await field.inputValue())).toBeLessThan(0.7);
  });
});

test.describe('slider gestures', () => {
  test('a cancelled drag puts the value back and leaves no undo entry', async ({ page }) => {
    await editor(page);
    const track = page.locator('aside.dock .row', { has: page.getByText('Contrast', { exact: true }) }).locator('.trk');
    const field = page.getByLabel('Contrast value', { exact: true });
    const box = (await track.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, y, { steps: 4 });
    await expect(field).not.toHaveValue('1.00');
    // What the browser sends when it takes the pointer away (a scroll, a system gesture).
    await track.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();
    await expect(field).toHaveValue('1.00');
    expect(await read(page, 'history.past.length')).toBe(0);
  });

  test('dragging back to the starting value lands on it', async ({ page }) => {
    await editor(page);
    const track = page.locator('aside.dock .row', { has: page.getByText('Contrast', { exact: true }) }).locator('.trk');
    const field = page.getByLabel('Contrast value', { exact: true });
    const box = (await track.boundingBox())!;
    const y = box.y + box.height / 2;
    const xOf = (v: number) => box.x + ((v - 0.5) / 1.5) * box.width;
    await page.mouse.move(xOf(1), y);
    await page.mouse.down();
    // What the start position maps to (pixel rounding may make it 1.01).
    const atStart = await field.inputValue();
    await page.mouse.move(xOf(1.6), y, { steps: 3 });
    expect(Number(await field.inputValue())).toBeGreaterThan(1.5);
    await page.mouse.move(xOf(1), y, { steps: 3 });
    await expect(field).toHaveValue(atStart);
    await page.mouse.up();
    expect(await read(page, 'params.contrast')).toBe(Number(atStart));
  });
});
