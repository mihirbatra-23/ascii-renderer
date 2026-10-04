import { expect, test, type Page } from '@playwright/test';
import { appImport, trackAppModules } from './appModules';

/**
 * The Adjust dock (src/ui/inspector): mode-dependent controls, store writes with one undo entry
 * per gesture, presets, Reset all with Undo, video-only Motion, and the phone sheet tabs.
 * Media is put in the store directly so these tests depend on the dock alone.
 */

const IMAGE = `{ name: 'torus.png', kind: 'image', width: 1280, height: 720, fileSize: 412000, formatLabel: 'PNG' }`;
const VIDEO = `{ name: 'loop.mp4', kind: 'video', width: 1280, height: 720, fileSize: 2800000, formatLabel: 'H.264', durationSec: 4, fps: 24, frameCount: 96 }`;

const withStore = (page: Page, js: string) => page.evaluate(`${appImport('/src/state/store.ts')}.then(({ useStore: s }) => { ${js} })`);
const read = (page: Page, path: string) => page.evaluate(`${appImport('/src/state/store.ts')}.then((m) => m.useStore.getState().${path})`);

async function openEditor(page: Page, info = IMAGE) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await withStore(page, `s.getState().setMedia({ status: 'ready', info: ${info} })`);
  await expect(page.locator('.dock .dh h2')).toHaveText('Adjust');
  // The dock slides in (panel-in, 240 ms): tests that drive the pointer from a measured box must
  // measure where the controls come to rest, not where they are mid-slide.
  await page.locator('.dock-panel').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

const dock = (page: Page) => page.locator('aside.dock');
const section = (page: Page, name: string) => dock(page).getByRole('region', { name });

// Before any navigation, so every module the app loads can be found (./appModules).
test.beforeEach(({ page }) => trackAppModules(page));

test.describe('desktop dock', () => {
  test('image: sections, derived grid readout and the Shape controls', async ({ page }) => {
    await openEditor(page);
    const modes = section(page, 'Mode').getByRole('radiogroup', { name: 'Render mode' });
    await expect(modes.getByRole('radio', { name: 'Shape' })).toHaveAttribute('aria-checked', 'true');
    await expect(section(page, 'Mode').locator('.hint')).toHaveText('Picks glyphs by each cell’s shape and brightness.');
    await expect(section(page, 'Mode').locator('.sh .aux')).toHaveCount(0);
    await expect(section(page, 'Grid').locator('.sh .aux')).toHaveText(/^45\s*rows$/);
    await expect(page.getByLabel('Columns value')).toHaveValue('160');
    await expect(section(page, 'Tone').getByLabel('Edge sharpness value')).toBeVisible();
    await expect(section(page, 'Tone').getByLabel('Dither value')).toHaveCount(0);
    await expect(section(page, 'Glyphs').locator('.sh .aux')).toHaveCount(0);
    await expect(section(page, 'Edges').locator('.sh .aux')).toHaveCount(0);
    await expect(section(page, 'Color').locator('.sh .aux')).toHaveCount(0);
    // No shortcut chips in the dock: the keys live in the tooltips.
    await expect(dock(page).locator('.db kbd')).toHaveCount(0);
    await expect(section(page, 'Motion')).toHaveCount(0);
    await expect(dock(page).getByRole('button', { name: /Advanced/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('columns drag is live and lands as one undo entry; rows follow', async ({ page }) => {
    await openEditor(page);
    const track = section(page, 'Grid').locator('.trk');
    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + box.width * (120 / 360), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    // Halfway along 40–400, give or take a pixel of rounding.
    await expect(page.getByLabel('Columns value')).toHaveValue(/^2(19|20|21)$/);
    await expect(section(page, 'Grid').locator('.sh .aux')).toHaveText(/^62\s*rows$/);
    expect(await read(page, 'history.past.length')).toBe(1);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByLabel('Columns value')).toHaveValue('160');
  });

  test('mode decides the controls: Ramp dither, Braille pattern, Halftone in Advanced', async ({ page }) => {
    await openEditor(page);
    const modes = section(page, 'Mode').getByRole('radiogroup', { name: 'Render mode' });
    await modes.getByRole('radio', { name: 'Ramp' }).click();
    await expect(section(page, 'Tone').getByLabel('Dither value')).toBeVisible();
    await expect(section(page, 'Tone').getByLabel('Edge sharpness value')).toHaveCount(0);
    await expect(dock(page).getByRole('button', { name: /Advanced/ })).toHaveText('Advanced');

    await modes.getByRole('radio', { name: 'Braille' }).click();
    const pattern = section(page, 'Tone').getByRole('radiogroup', { name: 'Dither' });
    await pattern.getByRole('radio', { name: 'Noise' }).click();
    expect(await read(page, 'params.ditherPattern')).toBe('noise');
    await expect(section(page, 'Glyphs')).toContainText('Braille draws its own dot patterns. Glyph sets apply to Shape and Ramp only.');
    await expect(section(page, 'Glyphs').getByRole('button', { name: /Glyph set/ })).toHaveCount(0);

    await modes.getByRole('radio', { name: 'Halftone' }).click();
    await dock(page).getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByLabel('Dot angle value')).toHaveValue('45°');
    await page.getByRole('button', { name: 'Dot shape: Round' }).click();
    await page.getByRole('option', { name: 'Diamond' }).click();
    expect(await read(page, 'params.halftoneShape')).toBe('diamond');
    await expect(dock(page).getByRole('button', { name: /^Font:/ })).toHaveCount(0);
  });

  test('custom glyph set: seeded from the current set, the density strip updates while typing', async ({ page }) => {
    await openEditor(page);
    await section(page, 'Glyphs').getByRole('button', { name: 'Glyph set: Full ASCII' }).click();
    await expect(page.getByRole('option', { name: /Extended/ })).toBeVisible();
    await page.getByRole('option', { name: /Minimal/ }).click();
    await section(page, 'Glyphs').getByRole('button', { name: 'Glyph set: Minimal' }).click();
    await page.getByRole('option', { name: /Custom/ }).click();
    const field = page.getByLabel('Custom glyphs');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('.:-=+*#%@');
    await page.keyboard.type('ABBA');
    await expect(section(page, 'Glyphs').locator('.glyphs .str')).toContainText('A');
  });

  test('color mode picks the swatches; a color pick is one undo entry', async ({ page }) => {
    await openEditor(page);
    const color = section(page, 'Color');
    await expect(color.locator('.swatch')).toHaveCount(3);
    await color.getByRole('radio', { name: 'Mono' }).click();
    await expect(color.locator('.swatch .n')).toHaveText(['Ink', 'Paper']);
    await color.getByRole('radio', { name: 'Source' }).click();
    await expect(color.locator('.swatch .n')).toHaveText(['Paper']);
    await color.getByRole('radio', { name: 'Duotone' }).click();
    const before = (await read(page, 'history.past.length')) as number;
    await color.getByRole('button', { name: /^Ink color/ }).click();
    const popover = page.getByRole('dialog', { name: 'Ink color' });
    await expect(popover.getByRole('slider', { name: 'Ink saturation and brightness' })).toBeFocused();
    await popover.getByLabel('Ink hex value').fill('ff0000');
    await page.keyboard.press('Enter');
    await expect(color.locator('.swatch', { hasText: 'Ink' }).locator('.h')).toHaveText('FF0000');
    expect(await read(page, 'history.past.length')).toBe(before + 1);
  });

  test('the color popover: a drag across the plane previews live and is one undo entry; Escape returns to the swatch', async ({ page }) => {
    await openEditor(page);
    const color = section(page, 'Color');
    await color.getByRole('radio', { name: 'Mono' }).click();
    const swatch = color.getByRole('button', { name: /^Paper color/ });
    await swatch.click();
    const popover = page.getByRole('dialog', { name: 'Paper color' });
    const before = (await read(page, 'history.past.length')) as number;
    const plane = popover.getByRole('slider', { name: 'Paper saturation and brightness' });
    const box = (await plane.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 5 });
    const mid = (await read(page, 'params.paper')) as string;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 3 });
    await page.mouse.up();
    expect(await read(page, 'params.paper')).not.toBe(mid);
    expect(await read(page, 'history.past.length')).toBe(before + 1);
    // Keyboard: the hue strip moves the hue; Tab stays inside the popover.
    await page.keyboard.press('Tab');
    await expect(popover.getByRole('slider', { name: 'Paper hue' })).toBeFocused();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(plane).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(swatch).toBeFocused();
    // Escape closed the popover only, not anything behind it.
    await expect(dock(page).locator('.dh h2')).toHaveText('Adjust');
  });

  test('Reset all restores defaults and its Undo restores the previous settings', async ({ page }) => {
    await openEditor(page);
    await withStore(page, `s.getState().setParams({ contrast: 1.5, mode: 'ramp' })`);
    await dock(page).getByRole('button', { name: 'Reset all' }).click();
    expect(await read(page, 'params.contrast')).toBe(1);
    expect(await read(page, 'params.mode')).toBe('shape');
    await page.locator('.toast').filter({ hasText: 'Settings reset' }).getByRole('button', { name: 'Undo' }).click();
    expect(await read(page, 'params.contrast')).toBe(1.5);
    expect(await read(page, 'params.mode')).toBe('ramp');
  });

  test('presets: apply a built-in, save your own, delete it', async ({ page }) => {
    await openEditor(page);
    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('menuitem', { name: /Braille dots/ }).click();
    expect(await read(page, 'params.mode')).toBe('braille');

    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('menuitem', { name: 'Save as preset…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save preset' });
    const name = dialog.getByLabel('Name');
    await expect(name).toBeFocused();
    await expect(dialog.locator('.hint')).toHaveText('Saved in this browser only.');
    // Save sits in the footer, outside the field, next to Cancel.
    await expect(dialog.locator('.dlg-f').getByRole('button')).toHaveText(['Cancel', 'Save']);
    await page.keyboard.type('Teletext');
    await expect(dialog.locator('.hint')).toHaveText('A built-in preset has this name. Choose another.');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await name.fill('Poster');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await read(page, 'userPresets.map((p) => p.name)')).toEqual(['Poster']);

    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await expect(page.getByRole('menuitem', { name: /Poster/ })).toBeVisible();
    await expect(page.getByRole('menu').locator('.mh')).toHaveText(['Built-in', 'Saved']);
    await page.getByRole('menuitem', { name: 'Delete presets…' }).click();
    await page.getByRole('button', { name: 'Delete preset Poster' }).click();
    expect(await read(page, 'userPresets.length')).toBe(0);
  });

  test('Delete presets… lists the saved presets with focus on a delete button, never the save form', async ({ page }) => {
    await openEditor(page);
    await withStore(page, `s.getState().savePreset('Poster'); s.getState().savePreset('Grain')`);
    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('menuitem', { name: 'Delete presets…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete presets' });
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Delete preset Poster' })).toBeFocused();
    // Enter acts on the focused delete button; focus moves to the row that takes its place.
    await page.keyboard.press('Enter');
    expect(await read(page, 'userPresets.map((p) => p.name)')).toEqual(['Grain']);
    await expect(dialog.getByRole('button', { name: 'Delete preset Grain' })).toBeFocused();
  });

  test('applying a preset says so, with an Undo; Reset all is disabled at the defaults', async ({ page }) => {
    await openEditor(page);
    await expect(dock(page).getByRole('button', { name: 'Reset all' })).toBeDisabled();
    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('menuitem', { name: /Teletext/ }).click();
    expect(await read(page, 'params.mode')).toBe('blocks');
    await expect(dock(page).getByRole('button', { name: 'Reset all' })).toBeEnabled();
    await page.locator('.toast').filter({ hasText: 'Applied Teletext' }).getByRole('button', { name: 'Undo' }).click();
    expect(await read(page, 'params.mode')).toBe('shape');
    await expect(dock(page).getByRole('button', { name: 'Reset all' })).toBeDisabled();
  });

  test('Copy settings link puts a link with the settings on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openEditor(page);
    await withStore(page, `s.getState().setParam('contrast', 1.5)`);
    await dock(page).getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('menuitem', { name: 'Copy settings link' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Settings link copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#s=[\w-]+$/);
  });

  test('Edges: Shape and Ramp only; the threshold follows the switch', async ({ page }) => {
    await openEditor(page);
    const edges = section(page, 'Edges');
    const threshold = edges.getByRole('slider', { name: 'Threshold' });
    await expect(threshold).toBeDisabled();
    await edges.getByRole('switch', { name: /Contour lines/ }).check();
    expect(await read(page, 'params.edges')).toBe(true);
    await expect(threshold).toBeEnabled();
    await expect(section(page, 'Mode').locator('.hint')).toHaveText('Picks glyphs by each cell’s shape and brightness.');
    await threshold.focus();
    await page.keyboard.press('Shift+ArrowRight');
    expect(await read(page, 'params.edgeThreshold')).toBe(0.6);
    await withStore(page, `s.getState().setParam('mode', 'ramp')`);
    await expect(edges).toBeVisible();
    await withStore(page, `s.getState().setParam('mode', 'braille')`);
    await expect(edges).toHaveCount(0);
  });

  test('tooltips: hover after a delay, keyboard focus at once, with a range from the control', async ({ page }) => {
    await openEditor(page);
    const tone = section(page, 'Tone');
    const gamma = tone.locator('.has-tip', { hasText: 'Gamma' });
    await gamma.hover();
    const tip = page.locator('.tip.note');
    await expect(tip).toBeVisible();
    await expect(tip.locator('p')).toHaveText('Lightens midtones below\u00a01, darkens them above\u00a01.');
    await expect(tip.locator('.tm')).toHaveText(/0\.40\s*to\s*2\.50/);
    await expect(gamma).toHaveClass(/\bon\b/);
    // Escape closes it.
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    // Keyboard focus shows the tip at once; the slider is described by it.
    await page.mouse.move(0, 0);
    const brightness = tone.getByRole('slider', { name: 'Brightness' });
    await brightness.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(tip.locator('.tm')).toHaveText(/−0\.50\s*to\s*\+0\.50/);
    await expect(brightness).toHaveAccessibleDescription('Lightens or darkens the image. −0.50 to +0.50.');
    // Invert: a label tip on the switch, with its key, and no indicator.
    await expect(tone.locator('.swrow .has-tip')).toHaveCount(0);
    await tone.getByRole('switch', { name: 'Invert' }).hover();
    await expect(page.locator('.tip:not(.note)')).toHaveText('Swaps light and darkI');
    // Section heads carry no tips.
    await expect(dock(page).locator('.sh .has-tip')).toHaveCount(0);
  });

  test('a capped grid names the limit that capped it', async ({ page }) => {
    await openEditor(page, `{ name: 'tall.jpg', kind: 'image', width: 300, height: 3000, fileSize: 1, formatLabel: 'JPEG' }`);
    await expect(section(page, 'Grid').getByText(/^Limited to \d+ columns\. A grid has at most 400 rows\.$/)).toBeVisible();
    await openEditor(page, `{ name: 'portrait.jpg', kind: 'image', width: 1000, height: 1800, fileSize: 1, formatLabel: 'JPEG' }`);
    await withStore(page, `s.getState().setParam('columns', 400)`);
    await expect(section(page, 'Grid').getByText(/^Limited to \d+ columns\. A grid has at most 120,000 cells\.$/)).toBeVisible();
  });

  test('keyboard: I toggles the Invert switch, Backspace on a track resets it', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.press('i');
    await expect(section(page, 'Tone').getByRole('switch', { name: 'Invert' })).toBeChecked();
    const gamma = section(page, 'Tone').getByRole('slider', { name: 'Gamma' });
    await gamma.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.getByLabel('Gamma value')).toHaveValue('1.21');
    await page.keyboard.press('Backspace');
    await expect(page.getByLabel('Gamma value')).toHaveValue('1.00');
  });
});

test.describe('video dock', () => {
  test('Motion section; Glyphs and Color collapse to summary rows', async ({ page }) => {
    await openEditor(page, VIDEO);
    const motion = section(page, 'Motion');
    await expect(motion.getByLabel('Stability value')).toHaveValue('0.50');
    await expect(motion.locator('.sh .aux')).toHaveCount(0);
    // The output frame rate is set in the Export panel only.
    await expect(motion.getByRole('radiogroup', { name: 'Output fps' })).toHaveCount(0);

    const glyphs = dock(page).getByRole('button', { name: /Glyphs/ });
    await expect(glyphs).toHaveText('GlyphsFull ASCII');
    await expect(glyphs).toHaveAttribute('aria-expanded', 'false');
    await glyphs.click();
    await expect(dock(page).getByRole('button', { name: 'Glyph set: Full ASCII' })).toBeVisible();
    await expect(dock(page).getByRole('button', { name: /Color/ })).toContainText('Duotone');
  });
});

test.describe('GIF dock', () => {
  test('a GIF: Stability only, no Output fps and no timing note', async ({ page }) => {
    await openEditor(page, `{ name: 'loop.gif', kind: 'animation', width: 480, height: 270, fileSize: 1, formatLabel: 'GIF', durationSec: 3, fps: 12, frameCount: 36 }`);
    const motion = section(page, 'Motion');
    await expect(motion.getByLabel('Stability value')).toHaveValue('0.50');
    await expect(motion.getByRole('radiogroup', { name: 'Output fps' })).toHaveCount(0);
    await expect(motion.locator('.hint')).toHaveCount(0);
  });
});

test.describe('light images', () => {
  async function open(page: Page, url: string) {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.evaluate(`${appImport('/src/app/controller.ts')}.then((c) => c.openSample(${JSON.stringify(url)}, ${JSON.stringify(url.split('/').pop())}))`);
    await page.waitForFunction(`${appImport('/src/state/store.ts')}.then(({ useStore }) => useStore.getState().media.status === 'ready')`);
  }

  test('line art suggests Invert, and the suggestion applies it', async ({ page }) => {
    await open(page, '/tests/fixtures/lineart_600x300.png');
    const hint = section(page, 'Tone').getByText(/^This image is mostly light\. Invert to draw its dark parts\.$/);
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: 'Invert' }).click();
    expect(await read(page, 'params.invert')).toBe(true);
    await expect(hint).toHaveCount(0);
  });

  test('a photo-like render and a transparent logo do not', async ({ page }) => {
    for (const url of ['/tests/fixtures/torus_450.png', '/tests/fixtures/logo_rgba_256.png']) {
      await open(page, url);
      await page.waitForTimeout(300);
      await expect(section(page, 'Tone').getByText(/^This image is mostly (light|dark)/)).toHaveCount(0);
    }
  });
});

test.describe('phone sheet', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tabs show Adjust, Glyphs and Color content; Mode lives in the strip', async ({ page }) => {
    await openEditor(page, VIDEO);
    const tabs = dock(page).getByRole('tablist', { name: 'Adjust panel' });
    await expect(dock(page).locator('.dh')).toBeHidden();
    await expect(section(page, 'Mode')).toBeHidden();
    await expect(section(page, 'Grid')).toBeVisible();
    await expect(section(page, 'Color')).toBeHidden();

    await tabs.getByRole('tab', { name: 'Glyphs' }).click();
    await expect(section(page, 'Grid')).toBeHidden();
    await expect(section(page, 'Glyphs').getByRole('button', { name: 'Glyph set: Full ASCII' })).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Color' })).toHaveAttribute('aria-selected', 'true');
    await expect(section(page, 'Color').getByRole('radiogroup', { name: 'Color mode' })).toBeVisible();
    expect(await read(page, 'ui.sheetTab')).toBe('color');
  });
});
