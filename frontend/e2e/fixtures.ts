import { expect, test as base, type Page } from '@playwright/test';
import { duplicateTestIds } from '../src/testIds';

/**
 * The shared test of the UI tests: import { test, expect } from './fixtures'.
 *
 * `expectUniqueTestIds()` checks the test id rule of src/testIds.ts on the
 * page: every data-testid once, repeated elements told apart by data-test-key.
 */
export const test = base.extend<{ expectUniqueTestIds: () => Promise<void> }>({
  expectUniqueTestIds: async ({ page }, use) => {
    await use(async () => {
      // Runs in the page, on <body> (duplicateTestIds is self-contained for this).
      const found = await page.locator('body').evaluate(duplicateTestIds);
      expect(found, 'test ids used more than once (src/testIds.ts)').toEqual([]);
    });
  },
});

export { expect };

/** Opens `path` and waits until the page's root element (data-testid) is shown. */
export const openPage = async (page: Page, path: string, pageTestId: string) => {
  await page.goto(path);
  await expect(page.getByTestId(pageTestId)).toBeVisible();
};

/** A location the test user sees (E2E_LOCATION_ID) - its pages are skipped without one. */
export const locationId = process.env.E2E_LOCATION_ID;
