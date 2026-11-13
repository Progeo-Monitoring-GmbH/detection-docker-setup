/**
 * Test ids for UI tests (Playwright, Testing Library) - see frontend/e2e/README.md.
 *
 * Every major element carries a `data-testid` in kebab-case,
 * `<page-or-component>-<element>` (e.g. "lageplan-wizard-step-3"). An element
 * rendered more than once (list rows, tiles, options) keeps ONE test id and
 * tells its copies apart with `data-test-key` (an id or value, not the index):
 *
 *     <div {...repeatedTestId('lageplan-tile', plan.id)}>
 *     ->  [data-testid="lageplan-tile"][data-test-key="1894"]
 *
 * duplicateTestIds() checks that rule (unit specs and Playwright).
 */

type TestIdPart = string | number | null | undefined | false;

/** A value as part of a test id: lowercase, a-z / 0-9, words joined by "-". */
export const testIdSlug = (value: string | number) =>
  String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A test id from its parts (empty ones are left out): testId('analyse', 'plan', 3) -> "analyse-plan-3". */
export const testId = (...parts: TestIdPart[]) =>
  parts
    .filter((part): part is string | number => part != null && part !== false && part !== '')
    .map(testIdSlug)
    .filter(Boolean)
    .join('-');

/** The test id of a child element ("-confirm", "-search", ...) - none without the parent's. */
export const childTestId = (parent: string | undefined, ...parts: TestIdPart[]) =>
  parent ? testId(parent, ...parts) : undefined;

/** The props of an element rendered more than once: one test id, its copies told apart by `key`. */
export const repeatedTestId = (id: string, key: string | number) => ({
  'data-testid': id,
  'data-test-key': String(key),
});

/**
 * The test ids under `root` that break the rule: used twice without a
 * data-test-key, or twice with the same one. Self-contained (no imports, no
 * closures) so Playwright can run it in the page via page.evaluate().
 */
export function duplicateTestIds(root: ParentNode): string[] {
  const seen = new Map<string, number>();
  root.querySelectorAll('[data-testid]').forEach((element) => {
    const id = element.getAttribute('data-testid') ?? '';
    const key = element.getAttribute('data-test-key');
    const name = key == null ? id : `${id}[${key}]`;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  });
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name, count]) => `${name} (${count}x)`);
}
