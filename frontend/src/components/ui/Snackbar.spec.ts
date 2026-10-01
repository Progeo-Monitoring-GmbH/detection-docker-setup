import { describe, expect, it, vi } from 'vitest';
import {
  errorReason,
  showErrorBar,
  showInfoBar,
  showRequestError,
  showSuccessBar,
} from './Snackbar.jsx';

describe('errorReason', () => {
  it('prefers the backend response.data.reason', () => {
    const error = {
      message: 'Request failed with status code 400',
      response: { data: { reason: 'Name taken' } },
    };
    expect(errorReason(error)).toBe('Name taken');
  });

  it('falls back to error.message when there is no reason', () => {
    expect(errorReason({ message: 'Network Error' })).toBe('Network Error');
    expect(errorReason({ message: 'boom', response: { data: {} } })).toBe('boom');
    expect(errorReason({ message: 'boom', response: { data: null } })).toBe('boom');
  });

  it('falls back to error.message when reason is an empty string', () => {
    expect(errorReason({ message: 'boom', response: { data: { reason: '' } } })).toBe('boom');
  });

  it('works for real Error instances', () => {
    expect(errorReason(new Error('kaputt'))).toBe('kaputt');
  });

  it('returns undefined for undefined/null/empty errors instead of throwing', () => {
    expect(errorReason(undefined)).toBeUndefined();
    expect(errorReason(null)).toBeUndefined();
    expect(errorReason({})).toBeUndefined();
  });
});

describe('snackbar helpers', () => {
  it('showSuccessBar enqueues the message with the success variant', () => {
    const enqueue = vi.fn();
    showSuccessBar(enqueue, 'Saved');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('Saved', { variant: 'success' });
  });

  it('showErrorBar enqueues the message with the error variant', () => {
    const enqueue = vi.fn();
    showErrorBar(enqueue, 'Failed');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('Failed', { variant: 'error' });
  });

  it('showInfoBar enqueues the message with the info variant', () => {
    const enqueue = vi.fn();
    showInfoBar(enqueue, 'FYI');
    expect(enqueue).toHaveBeenCalledWith('FYI', { variant: 'info' });
  });

  it('showRequestError prefixes the backend reason', () => {
    const enqueue = vi.fn();
    showRequestError(enqueue, 'Could not save', {
      message: 'x',
      response: { data: { reason: 'Forbidden field' } },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('Could not save: Forbidden field', { variant: 'error' });
  });

  it('showRequestError falls back to the transport message', () => {
    const enqueue = vi.fn();
    showRequestError(enqueue, 'Could not load', new Error('Network Error'));
    expect(enqueue).toHaveBeenCalledWith('Could not load: Network Error', { variant: 'error' });
  });

  it('showRequestError does not throw for a missing error (renders "undefined")', () => {
    const enqueue = vi.fn();
    showRequestError(enqueue, 'Oops', undefined);
    expect(enqueue).toHaveBeenCalledWith('Oops: undefined', { variant: 'error' });
  });
});
