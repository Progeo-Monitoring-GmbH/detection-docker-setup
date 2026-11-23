// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import PasswordStrengthMeter, {
  evaluatePasswordStrength,
} from './PasswordStrengthMeter';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('evaluatePasswordStrength', () => {
  it('is valid - like the backend (password_rules) - from 8 characters of three kinds', () => {
    expect(evaluatePasswordStrength('Ab1!xyz').valid).toBe(false); // 7 characters
    expect(evaluatePasswordStrength('alllowercaseonly').valid).toBe(false);
    expect(evaluatePasswordStrength('ALLUPPERCASE123').valid).toBe(false); // two kinds
    expect(evaluatePasswordStrength('lower-and-upperA').valid).toBe(true);
    expect(evaluatePasswordStrength('Given-Pa55word').level).toBe(
      'very_strong',
    );
  });
});

describe('PasswordStrengthMeter', () => {
  it('names its parts after the testId', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <PasswordStrengthMeter password="Given-Pa55word" testId="pw" />,
      ),
    );

    for (const part of [
      'strength',
      'strength-level',
      'min-length',
      'charset',
    ]) {
      expect(
        container.querySelector(`[data-testid="pw-${part}"]`),
      ).not.toBeNull();
    }
    act(() => root.unmount());
  });
});
