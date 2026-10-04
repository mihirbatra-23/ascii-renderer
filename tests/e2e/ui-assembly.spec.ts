import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The whole product through its real UI, the way a person uses it: start screen → sample → every
 * mode and colour mode → a live slider drag (with input → frame latency) → split, zoom, pan →
 * still exports → GIF and video fixtures through the picker → transport → motion exports → close.
 * Also the phone layout and variant B. No store pokes except to read state.
 *
 * Set UI_SHOTS_DIR to keep screenshots and the exported files as evidence.
 */
const FIXTURES = path.resolve('tests/fixtures');
const SHOTS = process.env.UI_SHOTS_DIR;

async function keep(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // Let panel swaps, sheet detents and the throttled status values settle.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function keepFile(from: string, name: string): void {
  if (!SHOTS) return;
  mkdirSync(path.join(SHOTS, 'files'), { recursive: true });
  copyFileSync(from, path.join(SHOTS, 'files', name));
}

/**
 * Imports an app module inside the page by the URL the app itself loaded it from: after a hot
 * update Vite serves a module as `…?t=…`, and a bare `/src/…` import would be a second instance.
 * (Strings, so tsc does not try to resolve them.)
 */
const mod = (file: string) =>
  `import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => new URL(n).pathname === '${file}') ?? '${file}')`;

const read = <T>(page: Page, expr: string) =>
  page.evaluate(`${mod('/src/state/store.ts')}.then(({ useStore }) => { const s = useStore.getState(); return ${expr}; })`) as Promise<T>;

/** The engine's current grid, row-major (what Copy text and the TXT export contain, minus newlines). */
const gridText = (page: Page) =>
  page.evaluate(`${mod('/src/app/runtime.ts')}.then(({ runtime }) => runtime.get().engine.snapshot().chars.join(''))`) as Promise<string>;

/** Console errors and page errors, asserted empty at the end of each journey. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function waitReady(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('img', { name: new RegExp(`^ASCII render of ${name.replace('.', '\\.')}, \\d+ by \\d+ cells$`) })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => read<string>(page, 's.media.status')).toBe('ready');
}

async function pick(page: Page, file: string): Promise<void> {
  const button = page.getByRole('button', { name: /^(Choose file|Open)$/ });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(path.join(FIXTURES, file));
}

async function download(page: Page, button: ReturnType<Page['getByRole']>, timeout = 30_000) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout }), button.click()]);
  const at = await file.path();
  keepFile(at, file.suggestedFilename());
  return { name: file.suggestedFilename(), bytes: readFileSync(at) };
}

async function pngSize(page: Page, bytes: Buffer): Promise<[number, number]> {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    return [bmp.width, bmp.height] as [number, number];
  }, bytes.toString('base64'));
}

/**
 * Records, for every change of `param` while the pointer is down, the time from the pointer event
 * that caused it to (a) the end of the draw that shows it, with the GPU finished (gl.finish), and
 * (b) the next animation frame after that draw, by which the compositor has the new pixels.
 */
async function recordLatency(page: Page, param: string): Promise<void> {
  await page.evaluate(`Promise.all([${mod('/src/app/engineHost.ts')}, ${mod('/src/state/store.ts')}]).then(([host, { useStore }]) => {
    const lat = (window.__latency = { drawn: [], shown: [] });
    let lastInput = 0;
    let pendingSince = null;
    addEventListener('pointermove', (e) => { lastInput = e.timeStamp; }, true);
    useStore.subscribe((s) => s.params[${JSON.stringify(param)}], () => { pendingSince ??= lastInput || performance.now(); });
    host.onDraw(() => {
      if (pendingSince === null) return;
      const since = pendingSince;
      pendingSince = null;
      document.querySelector('canvas.art-canvas')?.getContext('webgl2')?.finish();
      lat.drawn.push(performance.now() - since);
      requestAnimationFrame(() => lat.shown.push(performance.now() - since));
    });
  })`);
}

type Latency = { drawn: number[]; shown: number[] };
const latency = (page: Page) => page.evaluate('window.__latency') as Promise<Latency>;

function summary(ms: number[]): { p50: number; text: string } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { p50: at(0.5), text: `p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${s.at(-1)!.toFixed(1)} ms` };
}

test.describe.configure({ mode: 'serial' });

test('desktop: start → torus → modes, colours, live slider → split, zoom, pan → still exports → close', async ({ page }, info) => {
  const errors = watchErrors(page);
  await boot(page);
  await keep(page, 'start');

  // Start: the torus tile opens the editor in the look its tile shows.
  await page.getByRole('button', { name: /torus\.png/ }).click();
  await waitReady(page, 'torus.png');
  await expect(page.locator('.src-name')).toHaveText('torus.png');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('160 × 45');
  await keep(page, 'editor');

  // Every mode changes what the engine draws; Braille and Blocks use their own code points.
  const modes = page.getByRole('radiogroup', { name: 'Render mode' });
  const seen = new Map<string, string>();
  for (const mode of ['Ramp', 'Braille', 'Halftone', 'Blocks', 'Shape'] as const) {
    await modes.getByRole('radio', { name: mode }).click();
    await expect(modes.getByRole('radio', { name: mode })).toBeChecked();
    await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText(mode);
    await expect.poll(() => gridText(page)).not.toBe(seen.get([...seen.keys()].at(-1) ?? ''));
    seen.set(mode, await gridText(page));
  }
  expect(seen.get('Braille')).toMatch(/[⠁-⣿]/);
  expect(seen.get('Blocks')).toMatch(/[▀-▟]/);
  expect(new Set(seen.values()).size).toBe(5);

  // Colour modes: the swatches follow (Mono: Ink + Paper; Duotone adds Shadow).
  const colour = page.getByRole('radiogroup', { name: 'Color mode' });
  for (const [mode, swatches] of [
    ['Mono', ['Ink', 'Paper']],
    ['Source', []],
    ['Duotone', ['Shadow', 'Ink', 'Paper']],
  ] as const) {
    await colour.getByRole('radio', { name: mode }).click();
    await expect.poll(() => read<string>(page, 's.params.colorMode')).toBe(mode.toLowerCase());
    for (const s of swatches) await expect(page.locator('.swatch', { hasText: s }).first()).toBeVisible();
  }

  // A Contrast drag redraws on every move (no apply step) and lands as one undo entry.
  await recordLatency(page, 'contrast');
  const before = await gridText(page);
  const undoBefore = await read<number>(page, 's.history.past.length');
  const track = page.locator('.row', { has: page.getByText('Contrast', { exact: true }) }).locator('.trk');
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(box.x + box.width * (0.35 + i * 0.025), y);
    await page.waitForTimeout(32);
  }
  const mid = await latency(page);
  await expect(page.locator('html')).toHaveAttribute('data-adjusting', 'drag');
  await page.mouse.up();
  expect(mid.drawn.length, 'draws that showed a new value while the pointer was still down').toBeGreaterThanOrEqual(10);
  expect(await gridText(page)).not.toBe(before);
  expect(await read<number>(page, 's.history.past.length')).toBe(undoBefore + 1);
  const drawn = summary(mid.drawn);
  const shown = summary(mid.shown);
  const report = `${mid.drawn.length} drag moves · input → drawn (GPU finished): ${drawn.text} · input → next frame: ${shown.text}`;
  info.annotations.push({ type: 'latency', description: report });
  console.log(report);
  // Headless Chrome renders WebGL in software (SwiftShader); a real GPU is several times faster.
  expect(shown.p50).toBeLessThan(100);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => gridText(page)).toBe(before);

  // Split compare: chips, keyboard handle, caption.
  await page.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.split .chip.l')).toHaveText('Original');
  await expect(page.locator('.chip.r')).toHaveText(/^ASCII\s*·\s*Shape$/);
  const handle = page.getByRole('slider', { name: 'Split position' });
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '60');
  await expect(page.locator('.cap')).toContainText('Split 60%');
  await keep(page, 'compare');
  await page.getByRole('button', { name: 'Output' }).click();

  // Zoom and pan: + steps, a drag pans, F fits again.
  const zoomLabel = page.locator('.zoom-v');
  const fitLabel = await zoomLabel.textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLabel).not.toHaveText(fitLabel!);
  const frame = page.locator('.frm');
  const f0 = (await frame.boundingBox())!;
  await page.mouse.move(f0.x + f0.width / 2, f0.y + f0.height / 2);
  await page.mouse.down();
  await page.mouse.move(f0.x + f0.width / 2 + 120, f0.y + f0.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const f1 = (await frame.boundingBox())!;
  expect(Math.round(f1.x - f0.x)).toBe(120);
  expect(Math.round(f1.y - f0.y)).toBe(40);
  await page.keyboard.press('f');
  await expect(zoomLabel).toHaveText(fitLabel!);

  // Still exports through the panel: PNG at 2× has the size the panel promised.
  await page.getByRole('button', { name: /^Export/ }).first().click();
  const dock = page.getByRole('complementary', { name: 'Export' });
  await expect(dock.getByRole('heading', { name: 'Export' })).toBeVisible();
  await keep(page, 'export');
  await dock.getByRole('radio', { name: /^2×/ }).click();
  const readout = (await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label'))!;
  const png = await download(page, dock.getByRole('button', { name: /^Download PNG/ }));
  expect(png.name).toMatch(/^torus-ascii-160x45\.png$/);
  expect(`Output ${(await pngSize(page, png.bytes)).join(' by ')} pixels`).toBe(readout);
  expect(readout).toBe('Output 2560 by 1440 pixels');

  const rows = (await gridText(page)).length / 160;
  for (const [fmt, check] of [
    ['SVG', (t: string) => expect(t).toMatch(/^<\?xml|^<svg/)],
    ['TXT', (t: string) => expect(t.replace(/\r?\n$/, '').split(/\r?\n/)).toHaveLength(rows)],
    ['HTML', (t: string) => expect(t).toContain('<pre')],
  ] as const) {
    await dock.getByRole('radio', { name: new RegExp(`^${fmt}`) }).click();
    const file = await download(page, dock.getByRole('button', { name: `Download ${fmt}` }));
    expect(file.name).toBe(`torus-ascii-160x45.${fmt.toLowerCase()}`);
    check(file.bytes.toString('utf8'));
  }
  // ⌘↵ downloads even while a button (the HTML tile) has focus: a modified Enter is not activation.
  await dock.getByRole('radio', { name: /^HTML/ }).focus();
  const [viaKey] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('ControlOrMeta+Enter')]);
  expect(viaKey.suggestedFilename()).toBe('torus-ascii-160x45.html');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Adjust' })).toBeVisible();

  // Close returns to the start screen.
  await page.getByRole('button', { name: 'Close torus.png' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('desktop: GIF and video fixtures → transport → GIF and MP4 export → close', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await boot(page);

  // GIF through the real picker; the transport appears and mirrors the player.
  await pick(page, 'long_200_frames.gif');
  await waitReady(page, 'long_200_frames.gif');
  await expect(page.getByRole('group', { name: 'Playback' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  const frame0 = await read<number>(page, 's.playback.frame');
  await page.getByRole('button', { name: 'Next frame' }).click();
  await expect.poll(() => read<number>(page, 's.playback.frame')).toBe(frame0 + 1);
  await page.getByRole('button', { name: 'Previous frame' }).click();
  await expect.poll(() => read<number>(page, 's.playback.frame')).toBe(frame0);

  // Trim with the keyboard on the brackets: In moves 10 frames right, Out 10 frames left.
  const inHandle = page.getByRole('slider', { name: 'In point' });
  await inHandle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  const outHandle = page.getByRole('slider', { name: 'Out point' });
  await outHandle.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  const trim = await read<{ inPoint: number; outPoint: number; duration: number; frameCount: number }>(page, 's.playback');
  expect(trim.inPoint).toBeGreaterThan(0);
  expect(trim.outPoint).toBeLessThan(trim.duration);
  await keep(page, 'editor-gif');

  // GIF export of the trimmed range at 1×.
  await page.getByRole('button', { name: /^Export/ }).first().click();
  const dock = page.getByRole('complementary', { name: 'Export' });
  await dock.getByRole('radio', { name: /^GIF/ }).click();
  await dock.getByRole('radio', { name: /^1×/ }).click();
  const readout = (await dock.getByRole('img', { name: /^Output \d+ by \d+ pixels$/ }).getAttribute('aria-label'))!;
  const gif = await download(page, dock.getByRole('button', { name: /^Download GIF/ }), 120_000);
  expect(gif.bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  expect(`Output ${gif.bytes.readUInt16LE(6)} by ${gif.bytes.readUInt16LE(8)} pixels`).toBe(readout);
  await page.keyboard.press('Escape');

  // Video through the picker replaces the GIF; play / pause with Space.
  await pick(page, 'testsrc2_4s.mp4');
  await waitReady(page, 'testsrc2_4s.mp4');
  await expect(page.locator('.src-name')).toHaveText('testsrc2_4s.mp4');
  await page.locator('.vp').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect.poll(() => read<boolean>(page, 's.playback.playing')).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => read<boolean>(page, 's.playback.playing')).toBe(true);
  await keep(page, 'editor-video');

  await page.getByRole('button', { name: /^Export/ }).first().click();
  await dock.getByRole('radio', { name: /^MP4/ }).click();
  await dock.getByRole('radio', { name: /^1×/ }).click();
  const mp4 = await download(page, dock.getByRole('button', { name: /^Download MP4/ }), 120_000);
  expect(mp4.name).toMatch(/\.mp4$/);
  expect(mp4.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Close testsrc2_4s.mp4' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: sample → mode strip → sheet tabs → export sheet → back, no sideways scroll', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.getByRole('button', { name: /planet\.png/ }).click();
  await waitReady(page, 'planet.png');
  const strip = page.getByRole('region', { name: 'Render mode' });
  await strip.getByRole('radio', { name: 'Braille' }).click();
  await expect.poll(() => read<string>(page, 's.params.mode')).toBe('braille');
  for (const tab of ['Glyphs', 'Color', 'Adjust']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  await keep(page, 'phone-editor');
  await page.getByRole('button', { name: /^Export/ }).first().click();
  const sheet = page.getByRole('complementary', { name: 'Export' });
  await expect(sheet.getByRole('button', { name: /^Download PNG/ })).toBeInViewport();
  await keep(page, 'phone-export');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Adjust' })).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test('variant B: the theme switch re-tints the chrome and the render colours', async ({ page }) => {
  const errors = watchErrors(page);
  await boot(page);
  await page.getByRole('radio', { name: 'Carbon' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'b');
  await page.getByRole('button', { name: /torus\.png/ }).click();
  await waitReady(page, 'torus.png');
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim().toUpperCase());
  expect(accent).toBe('#C9F04F');
  expect(await read<string>(page, 's.params.ink')).toBe('#e4e7e8');
  await keep(page, 'b-editor');
  expect(errors).toEqual([]);
});
