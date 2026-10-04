import type { Page } from '@playwright/test';

/**
 * Page-side access to the app's own module instances. A dev server that has hot-updated a module
 * serves the app `/src/x.ts?t=<stamp>`; a plain `import('/src/x.ts')` from a test would then get a
 * second, separate instance (its own store, its own runtime). The page-side `__appImport(path)`
 * imports whatever URL the app itself loaded for that path, so tests read and drive the state the
 * UI shows.
 *
 *   test.beforeEach(({ page }) => trackAppModules(page))      before the first navigation
 *   page.evaluate(`${appImport('/src/state/store.ts')}.then((m) => …)`)      in an expression string
 *   page.evaluate(() => __appImport('/src/state/store.ts').then((m) => …))   in a page function
 */
export async function trackAppModules(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The dev build loads a few hundred modules; keep every resource entry.
    performance.setResourceTimingBufferSize(10_000);
    (window as unknown as { __appImport: (path: string) => Promise<unknown> }).__appImport = (path: string) => {
      const loaded = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((name) => new URL(name).pathname === path);
      return import(/* @vite-ignore */ loaded.at(-1) ?? path);
    };
  });
}

/** An expression (for page.evaluate strings) that resolves to the app's instance of `path`. */
export function appImport(path: string): string {
  return `window.__appImport(${JSON.stringify(path)})`;
}

declare global {
  // Installed by trackAppModules; typed loosely because the modules are the app's, not the test's.
  // eslint-disable-next-line no-var
  var __appImport: (path: string) => Promise<any>;
}
