// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CustomContentProps } from 'notistack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Toast, { TOAST_DURATION } from './Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const closeSnackbar = vi.fn();

vi.mock('notistack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('notistack')>()),
  useSnackbar: () => ({ closeSnackbar, enqueueSnackbar: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  closeSnackbar.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props: Partial<CustomContentProps> = {}) => {
  const all = {
    id: 7,
    message: 'Gespeichert',
    variant: 'success',
    persist: false,
    autoHideDuration: null,
    hideIconVariant: false,
    iconVariant: {},
    anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
    ...props,
  } as unknown as CustomContentProps;
  act(() => root.render(<Toast {...all} />));
  return {
    toast: container.querySelector<HTMLElement>('[data-testid="toast"]')!,
    progress: container.querySelector<HTMLElement>('[data-testid="toast-progress"]'),
  };
};

describe('Toast', () => {
  it('closes on a click anywhere', () => {
    const { toast } = render();

    act(() => toast.querySelector('.progeo-toast-message')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(closeSnackbar).toHaveBeenCalledWith(7);
  });

  it('runs a progress bar for the variant duration and closes when it ends', () => {
    const { progress } = render({ variant: 'error' });

    expect(progress?.style.animationDuration).toBe(`${TOAST_DURATION.error}ms`);
    expect(closeSnackbar).not.toHaveBeenCalled();
    // jsdom has no AnimationEvent - React then listens to the prefixed name.
    act(() => {
      progress!.dispatchEvent(new Event('animationend', { bubbles: true }));
      progress!.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }));
    });
    expect(closeSnackbar).toHaveBeenCalledWith(7);
  });

  it('takes the duration of the call', () => {
    const { progress } = render({ autoHideDuration: 1200 });
    expect(progress?.style.animationDuration).toBe('1200ms');
  });

  it('stays without a bar when persistent', () => {
    const { progress } = render({ persist: true });
    expect(progress).toBeNull();
  });

  it('does not close while hovered', () => {
    const { toast } = render();
    act(() => toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(closeSnackbar).not.toHaveBeenCalled();
  });
});
