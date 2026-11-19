import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notePermissionsVersion,
  onPermissionsChanged,
  resetPermissionsVersion,
} from './permissionVersion';

afterEach(() => resetPermissionsVersion());

describe('the permissions version of the answers', () => {
  it('takes the first one as the baseline and tells about a change', () => {
    const changed = vi.fn();
    const stop = onPermissionsChanged(changed);

    notePermissionsVersion('0');
    notePermissionsVersion('0');
    expect(changed).not.toHaveBeenCalled();

    notePermissionsVersion('a1b2c3');
    expect(changed).toHaveBeenCalledTimes(1);
    notePermissionsVersion('a1b2c3');
    expect(changed).toHaveBeenCalledTimes(1);

    stop();
    notePermissionsVersion('d4e5f6');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('ignores answers without one (public endpoints, other servers)', () => {
    const changed = vi.fn();
    const stop = onPermissionsChanged(changed);

    notePermissionsVersion('0');
    notePermissionsVersion(undefined);
    notePermissionsVersion('');
    notePermissionsVersion('0');

    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it('starts again after a logout - the next user is no change', () => {
    const changed = vi.fn();
    const stop = onPermissionsChanged(changed);

    notePermissionsVersion('user-a');
    resetPermissionsVersion();
    notePermissionsVersion('user-b');

    expect(changed).not.toHaveBeenCalled();
    stop();
  });
});
