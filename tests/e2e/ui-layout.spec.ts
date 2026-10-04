import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';

/**
 * The editor's chrome at the widths that used to break it: tablets, split-screen windows, 200% zoom,
 * short windows; the phone's More sheet; and the accessibility details of the stage and
 * transport.
 */

test.beforeEach(({ page }) => trackAppModules(page));

const store = <T>(page: Page, expr: string) => page.evaluate(`__appImport('/src/state/store.ts').then(({ useStore: s }) => (${expr}))`) as Promise<T>;

async function boot(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
}

async function openSample(page: Page, key: '1' | '2' | '3') {
  await page.keyboard.press(key);
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`, null, {
    timeout: 30_000,
  });
  await page.locator('.app').waitFor();
}

interface Box {
  what: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Visible controls and readouts in each bar of the editor, with the bar's own box: everything must
 * sit inside its bar, keep its size, and not overlap a neighbour.
 */
function measureBars(page: Page) {
  return page.evaluate(() => {
    const PARTS = 'button, input, a[href], .tc, .kv, .src-name, .src-meta, .it, .zoom-v, .lbl, .live-badge';
    const box = (el: Element, what: string) => {
      const r = el.getBoundingClientRect();
      return { what, x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return ['.top', '.sbar', '.tp-row', '.status'].map((sel) => {
      const bar = document.querySelector(sel)!;
      const parts = [...bar.querySelectorAll(PARTS)].filter(visible);
      // Only leaves of the selection: a segment's buttons, not the segment and its buttons.
      const leaves = parts.filter((el) => !parts.some((other) => other !== el && el.contains(other)));
      return {
        bar: box(bar, sel),
        parts: leaves.map((el) => box(el, `${sel} ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}"`)),
      };
    });
  });
}

/** How far two boxes overlap, as the smaller of the two extents: joined controls share a 1 px border. */
const overlap = (a: Box, b: Box) =>
  Math.min(Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)));

/** Every control inside its bar, on screen, and clear of its neighbours. */
async function expectBarsFit(page: Page, width: number, view: string) {
  for (const { bar, parts } of await measureBars(page)) {
    for (const p of parts) {
      expect.soft(p.x, `${view}: ${p.what} starts inside its bar`).toBeGreaterThanOrEqual(bar.x - 0.5);
      expect.soft(p.x + p.w, `${view}: ${p.what} ends inside its bar`).toBeLessThanOrEqual(bar.x + bar.w + 0.5);
      expect.soft(p.x + p.w, `${view}: ${p.what} is on screen`).toBeLessThanOrEqual(width + 0.5);
    }
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) expect.soft(overlap(parts[i], parts[j]), `${view}: ${parts[i].what} overlaps ${parts[j].what}`).toBeLessThanOrEqual(1);
  }
}

for (const width of [641, 700, 768, 820, 880, 900, 1024, 1440]) {
  test(`editor chrome fits at ${width} px with a clip open`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page);
    await openSample(page, '2');
    await page.waitForTimeout(300);
    await expectBarsFit(page, width, 'Output');
    // Split adds the compare menu, which once pushed Zoom in and Fit under the dock.
    await page.keyboard.press('s');
    await page.locator('.cmp-b').waitFor();
    await expectBarsFit(page, width, 'Split');
    await page.keyboard.press('s');
    // Controls keep their 32 px box instead of being squeezed, and the timecode stays on one line.
    const sizes = await page.evaluate(() => ({
      play: document.querySelector('.play')!.getBoundingClientRect().width,
      zoomIn: document.querySelector('.zoom button[aria-label="Zoom in"]')!.getBoundingClientRect().width,
      tc: document.querySelector('.tc')!.getBoundingClientRect().height,
    }));
    expect(sizes.play).toBe(32);
    expect(sizes.zoomIn).toBeGreaterThanOrEqual(26);
    expect(sizes.tc).toBeLessThanOrEqual(20);
    // The transport never spills over the dock.
    const tp = (await page.locator('.tp').boundingBox())!;
    const dock = (await page.locator('.dock').boundingBox())!;
    expect(tp.x + tp.width).toBeLessThanOrEqual(dock.x + 0.5);
  });
}

// Choose file, Paste, Camera and the URL field once ran out of the drop zone below ~780 px.
for (const width of [641, 700, 761, 900, 1100]) {
  test(`the start screen's open actions stay inside the drop zone at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page);
    const { zone, kids } = await page.evaluate(() => {
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, what: el.className || el.tagName };
      };
      const shown = [...document.querySelectorAll('.dz-acts > *')].filter((el) => (el as HTMLElement).offsetParent !== null);
      return { zone: rect(document.querySelector('.dz')!), kids: shown.map(rect) };
    });
    expect(kids.length).toBeGreaterThanOrEqual(3);
    for (const k of kids) {
      expect.soft(k.x, `${k.what} starts inside the drop zone`).toBeGreaterThanOrEqual(zone.x);
      expect.soft(k.x + k.w, `${k.what} ends inside the drop zone`).toBeLessThanOrEqual(zone.x + zone.w);
      expect.soft(k.y + k.h, `${k.what} stays above the zone's bottom`).toBeLessThanOrEqual(zone.y + zone.h);
    }
    await expect(page.getByRole('button', { name: 'Load' })).toBeInViewport({ ratio: 1 });
  });
}

test('a short window (1440 × 900 at 200% zoom) keeps the transport and status bar on screen', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await boot(page);
  await openSample(page, '2');
  const metrics = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollHeight, inner: innerHeight }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.inner);
  await expect(page.locator('.play')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toBeInViewport({ ratio: 1 });
});

test('the editor has a page heading naming the file', async ({ page }) => {
  await boot(page);
  await openSample(page, '1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('torus.png · ASCII Renderer');
});

test('the zoom readout is not a live region; deliberate zoom steps are announced', async ({ page }) => {
  await boot(page);
  await openSample(page, '1');
  const zoom = page.getByRole('group', { name: 'Zoom' });
  await expect(zoom.locator('output, [role="status"], [aria-live]')).toHaveCount(0);
  const live = page.locator('.sr.announcer');
  // Columns change the fit zoom on every step: none of that is spoken…
  for (let i = 0; i < 6; i++) await page.keyboard.press(']');
  await expect(live).toHaveText('Columns 166');
  // …while the zoom buttons say where they landed.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(live).toHaveText(/^Zoom \d+(\.\d)?%$/);
  await page.keyboard.press('f');
  await expect(live).toHaveText('Fit to stage');
});

test('keyboard toggles and undo say what they did', async ({ page }) => {
  await boot(page);
  await openSample(page, '1');
  const live = page.locator('.sr.announcer');
  await page.keyboard.press('i');
  await expect(live).toHaveText('Invert on');
  await page.keyboard.press('r');
  await expect(live).toHaveText('Rulers off');
  await page.keyboard.press('s');
  await expect(live).toHaveText('Split view');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(live).toHaveText('Undone: Invert');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(live).toHaveText('Redone: Invert');
});

test('the trim handles are not inside the timeline slider', async ({ page }) => {
  await boot(page);
  await openSample(page, '2');
  const timeline = page.getByRole('slider', { name: 'Timeline' });
  await expect(timeline).toBeVisible();
  expect(await timeline.evaluate((el) => el.querySelectorAll('[tabindex], button, input, [role="slider"]').length)).toBe(0);
  await expect(page.getByRole('slider', { name: 'In point' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Out point' })).toBeVisible();
  // Keyboard still steps frames on the timeline.
  await timeline.focus();
  await page.keyboard.press('Space');
  const before = await store<number>(page, 's.getState().playback.frame');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => store<number>(page, 's.getState().playback.frame')).not.toBe(before);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the More sheet gives phones undo, looks, reset, view, zoom, shortcuts and theme', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
    await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().stats.cols > 0)`);
    const more = page.getByRole('button', { name: 'More' });
    await more.click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    for (const name of ['Undo', 'Redo', 'Reset all', 'Fit', 'Keyboard shortcuts', 'Paste']) await expect(sheet.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(sheet.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();

    // A look closes the sheet so its result shows; Undo brings the previous one back.
    await sheet.getByRole('button', { name: 'Teletext' }).click();
    await expect(sheet).toBeHidden();
    expect(await store<string>(page, 's.getState().params.mode')).toBe('blocks');
    await more.click();
    await sheet.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await store<string>(page, 's.getState().params.mode')).toBe('shape');

    // Split, and what it compares with.
    await sheet.getByRole('button', { name: 'Split' }).click();
    expect(await store<string>(page, 's.getState().view.mode')).toBe('split');
    await more.click();
    await sheet.getByRole('radio', { name: 'Ramp' }).click();
    expect(await store<string>(page, 's.getState().view.compareWith')).toBe('ramp');

    await more.click();
    await sheet.getByRole('radio', { name: 'Carbon' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'b');
    await sheet.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');

    // saving a look and copying a settings link, as the dock's Presets menu offers on desktop.
    await more.click();
    await sheet.getByRole('button', { name: 'Save current…' }).click();
    const save = page.getByRole('dialog', { name: 'Save preset' });
    await expect(save).toBeVisible();
    await save.getByRole('button', { name: 'Save' }).click();
    expect(await store<number>(page, 's.getState().userPresets.length')).toBe(1);
    await more.click();
    await expect(sheet.getByRole('button', { name: 'Copy settings link' })).toBeVisible();
  });

  // the phone editor's landmarks and heading levels (axe: region, heading-order, banner).
  test('the mode strip is in a landmark, the sheet has an h2, and dialog headers are not banners', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
    await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().stats.cols > 0)`);
    await expect(page.getByRole('region', { name: 'Render mode' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Adjust' }).getByRole('heading', { level: 2, name: 'Adjust' })).toBeAttached();
    await page.getByRole('button', { name: 'More' }).click();
    const dialog = page.getByRole('dialog', { name: 'More' });
    await expect(dialog.locator('.dlg-h')).toBeVisible();
    await expect(dialog.getByRole('banner')).toHaveCount(0);
  });

  test('the 16:9 preview box shows its whole hairline frame', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
    await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().stats.cols > 0)`);
    await page.locator('.vp .va').waitFor();
    const { art, clip } = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON() as DOMRect;
      return { art: box('.va'), clip: box('.vp') };
    });
    expect(art.width / art.height).toBeCloseTo(16 / 9, 2);
    // The frame is a 1 px shadow outside the art box; the clipping stage must leave room for every
    // side of it (the bottom edge used to be cut off).
    expect(art.left - clip.left).toBeGreaterThanOrEqual(1);
    expect(art.top - clip.top).toBeGreaterThanOrEqual(1);
    expect(clip.right - art.right).toBeGreaterThanOrEqual(1);
    expect(clip.bottom - art.bottom).toBeGreaterThanOrEqual(1);
  });

  test('touch targets on a clip: trim handles and the sheet grabber reach 24 px', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: /Open sample interference_loop\.mp4/ }).click();
    await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().stats.cols > 0)`);
    const handle = (await page.getByRole('slider', { name: 'In point' }).boundingBox())!;
    // 10 px to the side of the 10 px handle still lands on it, not on the scrub area.
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute('aria-label'), [handle.x + handle.width / 2 + 10, handle.y + handle.height / 2]);
    expect(hit).toBe('In point');
    const grab = (await page.locator('.grab').boundingBox())!;
    expect(grab.height).toBeGreaterThanOrEqual(24);
  });
});
