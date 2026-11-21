import { expect, test as base, type Locator, type Page, type Request } from '@playwright/test';
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

/**
 * Unfolds every folded FoldPanel on the page (src/components/ui/kit/FoldPanel.tsx,
 * folded by default) - in rounds, an unfolded panel can hold folded ones.
 */
export const unfoldAll = async (page: Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const folded = page.locator('[data-testid="fold-toggle"][aria-expanded="false"]');
  for (let round = 0; round < 5 && (await folded.count()) > 0; round += 1) {
    await folded.evaluateAll((toggles) => toggles.forEach((toggle) => (toggle as HTMLElement).click()));
    // Bootstrap's Collapse transition.
    await page.waitForTimeout(400);
  }
};

/** A location the test user sees (E2E_LOCATION_ID) - its pages are skipped without one. */
export const locationId = process.env.E2E_LOCATION_ID;

/** The toasts of one variant (components/ui/Toast.tsx: data-variant). */
export const toasts = (page: Page, variant: 'error' | 'success' | 'info' | 'warning' | 'default') =>
  page.getByTestId('toast').and(page.locator(`[data-variant="${variant}"]`));

// ------------------------------------------------------------- destructive guard

/** A request the guard blocks: method plus a URL pattern (substring or RegExp). */
export type GuardedRequest = { method?: string; url: string | RegExp };

const matches = (request: Request, guarded: GuardedRequest) => {
  const method = (guarded.method || 'POST').toUpperCase();
  if (request.method().toUpperCase() !== method) {
    return false;
  }
  const url = request.url();
  return typeof guarded.url === 'string' ? url.includes(guarded.url) : guarded.url.test(url);
};

/**
 * Blocks the destructive requests `guarded` on this page - they never reach
 * the server (the tests run against staging and its real data): each is
 * answered with 418 and recorded. Returns the recorded requests.
 */
export const blockDestructive = async (page: Page, guarded: GuardedRequest[]) => {
  const sent: Request[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (guarded.some((entry) => matches(request, entry))) {
      sent.push(request);
      await route.fulfill({
        status: 418,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'blocked by the e2e destructive guard' }),
      });
      return;
    }
    await route.fallback();
  });
  return sent;
};

/**
 * The rule "every destructive action asks first": clicking `trigger` opens
 * the dialog `dialog` (a ConfirmDialog: `<dialog>-confirm` / `<dialog>-cancel`)
 * which explains the consequences (`minText` characters at least) - and no
 * request matching `guarded` is sent. Cancel closes it, still without a request.
 * The confirm button is never clicked.
 */
export const expectConfirmGuard = async (
  page: Page,
  {
    trigger,
    dialog,
    guarded,
    minText = 25,
  }: { trigger: Locator; dialog: string; guarded: GuardedRequest[]; minText?: number },
) => {
  const sent = await blockDestructive(page, guarded);
  await trigger.click();
  const box = page.getByTestId(dialog);
  await expect(box, `the dialog ${dialog} opens`).toBeVisible();
  await expect(page.getByTestId(`${dialog}-confirm`)).toBeVisible();
  const text = (await box.innerText()).trim();
  expect(text.length, `the dialog ${dialog} explains the consequences`).toBeGreaterThanOrEqual(minText);
  expect(sent, 'nothing is sent before the confirmation').toHaveLength(0);

  await page.getByTestId(`${dialog}-cancel`).click();
  await expect(box).toBeHidden();
  // A request fired late (e.g. by the click itself) would show up now.
  await page.waitForTimeout(300);
  expect(sent, 'nothing is sent after Cancel').toHaveLength(0);
};
