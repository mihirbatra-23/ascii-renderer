import type { Page } from '@playwright/test';

/**
 * How many live regions currently hold `text` (each toast must be announced by exactly one).
 * A region nested in another live region is counted too, since screen readers announce both.
 */
export function liveRegionsSaying(page: Page, text: string): Promise<number> {
  return page.evaluate((text) => {
    const live = document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]');
    return Array.from(live).filter((el) => el.textContent?.includes(text)).length;
  }, text);
}
