import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The production build, served from disk at a fake origin (no server): its Content-Security-Policy
 * holds for real use (no violations), the first load does not carry the export code or inlined
 * fonts, and the start screen's thumbnails are cached across visits. The dev server must stay
 * without a CSP (Vite's client needs inline scripts).
 */

const ORIGIN = 'http://app.test';
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.map': 'application/json',
};

let dist = '';

test.beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-build-'));
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { stdio: 'pipe' });
});

test.afterAll(() => {
  if (dist) fs.rmSync(dist, { recursive: true, force: true });
});

/** Serves the build; returns the paths requested, in order. */
async function serve(context: BrowserContext): Promise<string[]> {
  const requested: string[] = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    requested.push(rel);
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    await route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
  });
  return requested;
}

/** Every CSP violation the page reports. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load ${e.blockedURI} (${e.violatedDirective})`));
  });
  return violations;
}

test('the build ships a CSP that the app lives within', async ({ context, page }) => {
  await serve(context);
  const violations = await watchCsp(page);
  await page.goto(`${ORIGIN}/`);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  // A sample (fetched from the app's origin) and the thumbnails before it.
  await page.getByRole('button', { name: /Open sample torus\.png/ }).click();
  await page.waitForFunction(() => !!document.querySelector('.app canvas'), null, { timeout: 30_000 });
  // A GIF through the file picker, then the lazy export panel, its worker-backed encoder and a download.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Open', exact: true }).click()]);
  await chooser.setFiles(path.resolve('tests/fixtures/transparent_variable_duration.gif'));
  await expect(page.locator('.src-name')).toHaveText('transparent_variable_duration.gif');
  await page.getByRole('button', { name: /^Export/ }).first().click();
  await page.getByRole('radio', { name: /^GIF/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByRole('button', { name: /^Download GIF/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.gif$/);
  expect(violations).toEqual([]);
});

test('the first load leaves out the exporters and inlined fonts', async ({ context, page }) => {
  const requested = await serve(context);
  await page.goto(`${ORIGIN}/`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.waitForTimeout(500);
  expect(requested.filter((p) => /ExportPanel/.test(p))).toEqual([]);
  const css = requested.filter((p) => p.endsWith('.css')).map((p) => fs.readFileSync(path.join(dist, p), 'utf8'));
  expect(css.length).toBeGreaterThan(0);
  for (const sheet of css) expect(sheet).not.toMatch(/data:font\/woff2/);
});

test('sample thumbnails come from small sources and are cached across visits', async ({ context, page }) => {
  const requested = await serve(context);
  await page.goto(`${ORIGIN}/`);
  await expect(page.locator('.tile .art[data-ready]')).toHaveCount(3, { timeout: 20_000 });
  // The tiles never download the samples themselves (the video is 300 KB).
  expect(requested.filter((p) => /^\/samples\/[^/]+$/.test(p))).toEqual([]);
  expect(requested.filter((p) => p.startsWith('/samples/thumbs/'))).toHaveLength(3);
  const first = await page.locator('.tile .art').first().textContent();

  requested.length = 0;
  await page.reload();
  // Drawn on the first render from storage: no fetches, no waiting for idle time.
  await expect(page.locator('.tile .art[data-ready]')).toHaveCount(3);
  expect(requested.filter((p) => p.startsWith('/samples/'))).toEqual([]);
  expect(await page.locator('.tile .art').first().textContent()).toBe(first);
});

test('the dev server has no CSP (Vite’s client needs inline scripts)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(0);
});
