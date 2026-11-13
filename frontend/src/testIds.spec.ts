// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { childTestId, duplicateTestIds, repeatedTestId, testId, testIdSlug } from './testIds';

describe('testId', () => {
  it('joins its parts in kebab-case and leaves out empty ones', () => {
    expect(testId('Analyse', 'Plan', 3)).toBe('analyse-plan-3');
    expect(testId('wizard', null, undefined, false, '', 'step')).toBe('wizard-step');
  });

  it('slugs labels with umlauts and symbols', () => {
    expect(testIdSlug('Bürogebäude (smartex® io)')).toBe('burogebaude-smartex-io');
    expect(testIdSlug('Straße 7d')).toBe('strasse-7d');
  });

  it('derives child ids only from a parent id', () => {
    expect(childTestId('confirm-dialog', 'cancel')).toBe('confirm-dialog-cancel');
    expect(childTestId(undefined, 'cancel')).toBeUndefined();
  });
});

describe('duplicateTestIds', () => {
  const render = (html: string) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  };

  it('accepts unique ids and repeated ones told apart by data-test-key', () => {
    const { 'data-test-key': key } = repeatedTestId('tile', 7);
    expect(key).toBe('7');
    const root = render(`
      <div data-testid="page"></div>
      <div data-testid="tile" data-test-key="1"></div>
      <div data-testid="tile" data-test-key="2"></div>`);
    expect(duplicateTestIds(root)).toEqual([]);
  });

  it('reports ids used twice without a key, or with the same key', () => {
    const root = render(`
      <div data-testid="save"></div>
      <div data-testid="save"></div>
      <div data-testid="tile" data-test-key="1"></div>
      <div data-testid="tile" data-test-key="1"></div>`);
    expect(duplicateTestIds(root)).toEqual(['save (2x)', 'tile[1] (2x)']);
  });
});
