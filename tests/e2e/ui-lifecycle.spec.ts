import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';
import { liveRegionsSaying } from './liveRegions';

/**
 * Media lifecycle in the running app (src/app/controller.ts): which media owns the engine's source
 * when opens race, fail or replace a playing clip, the levels a new clip starts with, the start
 * screen during a first open, error copy, and media kept alive for a running export.
 */

const FIXTURES = '/tests/fixtures';

test.beforeEach(async ({ page }) => {
  await trackAppModules(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
});

/** Opens a fixture (served by the dev server) through the controller, as a drop or paste would. */
async function open(page: Page, url: string, name = url.split('/').pop()!) {
  await page.evaluate(
    async ([url, name]) => {
      const { openFile } = await __appImport('/src/app/controller.ts');
      const blob = await (await fetch(url)).blob();
      await openFile(blob, name);
    },
    [url, name],
  );
}

async function settled(page: Page, name: string) {
  await page.waitForFunction(
    (name) =>
      __appImport('/src/state/store.ts').then(({ useStore }) => {
        const s = useStore.getState();
        return s.media.status === 'ready' && s.media.info?.name === name && s.stats.cols > 0;
      }),
    name,
    { timeout: 30_000 },
  );
}

/** What the engine is showing (its source info is internal; read it the way a debugger would). */
const engineState = (page: Page) =>
  page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const { engine, media, player } = runtime.get();
    const info = (engine as unknown as { info: { width: number; height: number; animated: boolean } | null }).info;
    return { info, grid: engine!.getGrid(), media: media?.name, playing: player?.playing ?? null };
  });

/** Records every setSource / setLevels the engine receives from now on. */
async function traceEngine(page: Page) {
  await page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const engine = runtime.get().engine! as unknown as Record<string, (...args: unknown[]) => unknown> & { __traced?: boolean };
    const w = window as unknown as { __trace: unknown[] };
    w.__trace = [];
    if (engine.__traced) return;
    engine.__traced = true;
    const setSource = engine.setSource.bind(engine);
    const setLevels = engine.setLevels.bind(engine);
    engine.setSource = (src, info) => {
      const { width, height } = info as { width: number; height: number };
      w.__trace.push({ kind: 'source', width, height });
      return setSource(src, info);
    };
    engine.setLevels = (levels) => {
      w.__trace.push({ kind: 'levels', ...(levels as object) });
      return setLevels(levels);
    };
  });
}

const trace = (page: Page) => page.evaluate(() => (window as unknown as { __trace: { kind: string; width?: number; height?: number; black?: number; white?: number }[] }).__trace);

test('a GIF still playing never replaces a newly opened still', async ({ page }) => {
  // replacing the playing GIF while a frame decodes must not surface an uncaught "file was closed".
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await open(page, `${FIXTURES}/long_200_frames.gif`);
  await settled(page, 'long_200_frames.gif');
  await traceEngine(page);
  // A large still decodes slowly, which is what gave the old clip's late frames their window.
  for (let run = 0; run < 4; run++) {
    await open(page, `${FIXTURES}/long_200_frames.gif`);
    await settled(page, 'long_200_frames.gif');
    await page.waitForTimeout(150 + run * 120);
    await page.evaluate(async () => {
      const w = window as unknown as { __trace: unknown[] };
      w.__trace = [];
      // Noise, so the PNG stays large and slow to decode.
      const canvas = new OffscreenCanvas(4000, 4000);
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(4000, 4000);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.imul(i, 2654435761) >>> 24;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const { openFile } = await __appImport('/src/app/controller.ts');
      await openFile(blob, 'big.png');
    });
    await settled(page, 'big.png');
    await page.waitForTimeout(300);
    const events = await trace(page);
    const first = events.findIndex((e) => e.kind === 'source' && e.width === 4000);
    expect(first).toBeGreaterThanOrEqual(0);
    // Nothing from the GIF reached the engine after the still did.
    expect(events.slice(first).filter((e) => e.kind === 'source' && e.width === 160)).toEqual([]);
    const state = await engineState(page);
    expect(state.info).toEqual({ width: 4000, height: 4000, animated: false });
    expect(state.media).toBe('big.png');
  }
  expect(pageErrors).toEqual([]);
});

// a damaged GIF whose header claims a huge screen said "too large", and every decode failure
// offered a Try again that could only fail the same way.
test('a damaged GIF says it cannot be read, without a pointless Try again', async ({ page }) => {
  await page.evaluate(async () => {
    const bytes = new Uint8Array(13 + 768 + 64);
    bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    new DataView(bytes.buffer).setUint16(6, 52944, true);
    new DataView(bytes.buffer).setUint16(8, 36208, true);
    bytes[10] = 0xf7;
    bytes.fill(0x5a, 13 + 768);
    const { openFile } = await __appImport('/src/app/controller.ts');
    await openFile(new Blob([bytes]), 'garbage.gif');
  });
  const toast = page.locator('.toast').filter({ hasText: 'Couldn’t open garbage.gif' });
  await expect(toast).toContainText('The GIF has no readable frames. It may be damaged or incomplete.');
  await expect(toast.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('an open that goes stale or fails leaves the playing clip on screen and playing', async ({ page }) => {
  await open(page, `${FIXTURES}/transparent_variable_duration.gif`);
  await settled(page, 'transparent_variable_duration.gif');
  // A video starts loading, then a damaged PNG is dropped before the video is ready: the video's open
  // is superseded, the PNG fails, and neither may leave a trace on the stage.
  await page.evaluate(async () => {
    const { openFile } = await __appImport('/src/app/controller.ts');
    const video = await (await fetch('/tests/fixtures/testsrc2_4s.mp4')).blob();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(3000).fill(7)]);
    const first = openFile(video, 'testsrc2_4s.mp4');
    await new Promise((r) => setTimeout(r, 30));
    await Promise.all([first, openFile(new Blob([png]), 'broken.png')]);
  });
  await expect(page.locator('.toast').filter({ hasText: 'broken.png' })).toBeVisible();
  await page.waitForTimeout(500);
  const state = await engineState(page);
  expect(state.media).toBe('transparent_variable_duration.gif');
  expect(state.info).toEqual({ width: 320, height: 240, animated: true });
  expect(state.playing).toBe(true);
  await expect(page.locator('.src-name')).toHaveText('transparent_variable_duration.gif');
});

test('a new clip’s first frame uses its own levels, never the previous file’s', async ({ page }) => {
  await open(page, `${FIXTURES}/logo_rgba_256.png`);
  await settled(page, 'logo_rgba_256.png');
  await traceEngine(page);
  await open(page, `${FIXTURES}/testsrc2_4s.mp4`);
  await settled(page, 'testsrc2_4s.mp4');
  const events = await trace(page);
  const firstFrame = events.findIndex((e) => e.kind === 'source' && e.width !== 256);
  expect(firstFrame).toBeGreaterThan(0);
  // The clip's levels are set before its first frame, in the same commit.
  expect(events[firstFrame - 1].kind).toBe('levels');
});

test('a file that fails from the start screen never flashes the editor, and focus stays put', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __editorSeen: boolean };
    w.__editorSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.app')) w.__editorSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const choose = page.getByRole('button', { name: /Choose file/ });
  // Subscribe before the focus round trip: a bare key press can reach the page before Playwright has
  // switched on file-chooser interception (unlike a click, it has no actionability steps to wait
  // through), and the native picker it then opens never fires the event.
  const chooserOpened = page.waitForEvent('filechooser');
  await choose.focus();
  await page.keyboard.press('Enter');
  const chooser = await chooserOpened;
  await chooser.setFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n' + 'x'.repeat(2000)) });
  const toast = page.locator('.toast').filter({ hasText: 'That file type isn’t supported' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('doc.pdf can’t be opened. Use PNG, JPG, WEBP, AVIF, GIF, SVG, MP4, WEBM or MOV.');
  expect(await page.evaluate(() => (window as unknown as { __editorSeen: boolean }).__editorSeen)).toBe(false);
  await expect(choose).toBeFocused();
  // The announcement is the toast's title and body once, not the title twice, and it is
  // said by one live region only: the toast host's alert region.
  const message = 'That file type isn’t supported. doc.pdf can’t be opened. Use PNG, JPG, WEBP, AVIF, GIF, SVG, MP4, WEBM or MOV.';
  await expect(page.locator('.sr.toast-live[role="alert"]')).toHaveText(message);
  expect(await liveRegionsSaying(page, 'doc.pdf')).toBe(1);
});

test('an empty file says what to do next', async ({ page }) => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose file/ }).click()]);
  await chooser.setFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
  const toast = page.locator('.toast').filter({ hasText: 'empty.png is empty' });
  await expect(toast).toContainText('The file has no data. Try the original file.');
});

test('the start screen shows what is opening while the first file loads', async ({ page }) => {
  await page.route('**/samples/torus.png', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
  const zone = page.getByRole('region', { name: 'Open a file' });
  await expect(zone.getByRole('heading', { name: 'Opening torus.png…' })).toBeVisible();
  await expect(zone).toHaveAttribute('aria-busy', 'true');
  await settled(page, 'torus.png');
  // The editor continues from the preview, not from the top of the page.
  await expect(page.getByRole('main', { name: 'Preview' })).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('torus.png · ASCII Renderer');
});

test('replaced media stays readable while something (an export) retains it', async ({ page }) => {
  await open(page, `${FIXTURES}/transparent_variable_duration.gif`);
  await settled(page, 'transparent_variable_duration.gif');
  await page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const media = runtime.get().media!;
    (window as unknown as { __old: unknown; __release: () => void }).__old = media;
    (window as unknown as { __release: () => void }).__release = media.retain();
  });
  await open(page, `${FIXTURES}/terrain_640x360.png`);
  await settled(page, 'terrain_640x360.png');
  const read = () =>
    page.evaluate(async () => {
      const old = (window as unknown as { __old: { getFrame(i: number): Promise<{ width: number }> } }).__old;
      return old.getFrame(5).then(
        (f) => f.width,
        (e: Error) => e.message,
      );
    });
  expect(await read()).toBe(320);
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  expect(await read()).not.toBe(320);
});

test('closing returns to the start screen and stops the clip', async ({ page }) => {
  await open(page, `${FIXTURES}/testsrc2_4s.mp4`);
  await settled(page, 'testsrc2_4s.mp4');
  const element = await page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const media = runtime.get().media as { element: HTMLVideoElement };
    (window as unknown as { __el: HTMLVideoElement }).__el = media.element;
    return true;
  });
  expect(element).toBe(true);
  await page.getByRole('button', { name: 'Back to start screen' }).click();
  await page.getByRole('alertdialog', { name: 'Close testsrc2_4s.mp4?' }).getByRole('button', { name: 'Close file' }).click();
  await expect(page.getByRole('region', { name: 'Open a file' })).toBeVisible();
  const after = await page.evaluate(async () => {
    const { runtime } = await __appImport('/src/app/runtime.ts');
    const el = (window as unknown as { __el: HTMLVideoElement }).__el;
    return { media: runtime.get().media ?? null, paused: el.paused, src: el.getAttribute('src') };
  });
  expect(after.media).toBeNull();
  expect(after.paused).toBe(true);
  expect(after.src).toBeNull();
});
