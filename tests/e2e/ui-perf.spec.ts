import { expect, test, type Page } from '@playwright/test';
import { trackAppModules } from './appModules';

/**
 * Main-thread budget at the moments that used to stall: a first-time visitor's
 * first open, which used to compile every first-draw program in one 400–900 ms task, and
 * a Line height drag, which waited 160–270 ms per step on a synchronous framebuffer check queued
 * behind a background compile. Long tasks and animation-frame gaps are observed in the page.
 */

const COLD_SHADERS = `(() => {
  // A unique no-op in every fragment shader, so neither Chrome's nor the driver's shader cache can
  // hit: every compile is a first-time visitor's.
  const nonce = Math.floor(Math.random() * 1e9);
  const shaderSource = WebGL2RenderingContext.prototype.shaderSource;
  let n = 0;
  WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
    if (/void main\\(\\)\\s*\\{/.test(source) && !/gl_Position/.test(source)) {
      source = source.replace(/void main\\(\\)\\s*\\{/, (m) => m + ' if (gl_FragCoord.x < -' + (nonce + ++n) + '.5) discard; ');
    }
    return shaderSource.call(this, shader, source);
  };
})()`;

const WATCH = `(() => {
  const w = (window.__perf = { long: [], gaps: [], on: false });
  new PerformanceObserver((list) => { if (w.on) for (const e of list.getEntries()) w.long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
  let prev = 0;
  const loop = (t) => { if (w.on && prev) w.gaps.push(t - prev); prev = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

interface Perf {
  long: number[];
  gaps: number[];
}

const startWatching = (page: Page) => page.evaluate(() => Object.assign((window as unknown as { __perf: Perf & { on: boolean } }).__perf, { long: [], gaps: [], on: true }));
const stopWatching = (page: Page) =>
  page.evaluate(() => {
    const w = (window as unknown as { __perf: Perf & { on: boolean } }).__perf;
    w.on = false;
    return { long: w.long, maxGap: Math.round(Math.max(0, ...w.gaps)) };
  });

async function openTorus(page: Page) {
  await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().media.status === 'ready' && useStore.getState().stats.cols > 0)`, null, {
    timeout: 30_000,
  });
  await page.locator('.app').waitFor();
}

test.beforeEach(async ({ page }) => {
  await trackAppModules(page);
  await page.addInitScript(WATCH);
});

test('a first-time visitor’s first open compiles nothing on the main thread', async ({ page }) => {
  await page.addInitScript(COLD_SHADERS);
  await page.goto('/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  // The engine is created, and starts compiling, while the start screen is idle.
  await page.waitForTimeout(1500);
  await startWatching(page);
  await openTorus(page);
  await page.waitForTimeout(500);
  const { long } = await stopWatching(page);
  console.log('first open long tasks', JSON.stringify(long));
  expect(Math.max(0, ...long)).toBeLessThan(100);
});

test('dragging Line height never stalls on a shader compile', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openTorus(page);
  await page.getByRole('button', { name: /^Advanced/ }).first().click();
  const slider = page.getByRole('slider', { name: 'Line height', exact: true }).first();
  await slider.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const box = (await slider.locator('xpath=..').boundingBox())!;
  const y = box.y + box.height / 2;
  await startWatching(page);
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  // Across the whole range and back, one step per frame: every line height is a new geometry.
  const lineHeight = () => page.evaluate(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().params.lineHeight)`);
  const start = await lineHeight();
  let far = start;
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(box.x + 2 + (box.width - 4) * (i <= 30 ? i / 30 : (60 - i) / 30), y);
    await page.waitForTimeout(16);
    if (i === 30) far = await lineHeight();
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const { long, maxGap } = await stopWatching(page);
  console.log('line-height drag long tasks', JSON.stringify(long), 'max frame gap', maxGap);
  expect(far, 'the drag reached the other end of the range').not.toBe(start);
  expect(long).toEqual([]);
  expect(maxGap).toBeLessThan(100);
});

test('opening a 64 MP still does not block the page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  // Made (and PNG-encoded) before watching: only the open itself is measured.
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8000, 8000);
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 8000, 8000);
    gradient.addColorStop(0, '#111');
    gradient.addColorStop(1, '#eee');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 8000, 8000);
    (window as unknown as { __big: Blob }).__big = await canvas.convertToBlob({ type: 'image/png' });
  });
  await page.waitForTimeout(1500);
  await startWatching(page);
  await page.evaluate(async () => {
    const { openFile } = await __appImport('/src/app/controller.ts');
    await openFile((window as unknown as { __big: Blob }).__big, 'big.png');
  });
  await page.waitForFunction(`__appImport('/src/state/store.ts').then(({ useStore }) => useStore.getState().stats.cols > 0)`, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const { long } = await stopWatching(page);
  console.log('64 MP open long tasks', JSON.stringify(long));
  expect(Math.max(0, ...long)).toBeLessThan(100);
  // The file's own size is what the editor reports, whatever size the bitmap is kept at.
  expect(await page.evaluate(`__appImport('/src/state/store.ts').then(({ useStore }) => [useStore.getState().media.info.width, useStore.getState().media.info.height])`)).toEqual([8000, 8000]);
});
