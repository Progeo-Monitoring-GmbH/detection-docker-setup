import { describe, expect, it } from 'vitest';
import { bundleVersionLabel } from './firmwareBundle';

const bundle = (id: string, release: string | null = null, firmware: string | null = null) => ({ id, release, firmware });

describe('bundleVersionLabel', () => {
  it('reads release and firmware from the bundle id', () => {
    expect(bundleVersionLabel(bundle('v1.0.0_fw-v1.6.1-tls-lua53'))).toBe('v1.0.0 (FW: v1.6.1)');
  });

  it('prefers the fields and drops the firmware build suffix', () => {
    expect(bundleVersionLabel(bundle('whatever', 'v2.1.0', 'v1.7.0-tls-lua53'))).toBe('v2.1.0 (FW: v1.7.0)');
  });

  it('shows the release alone without a firmware version', () => {
    expect(bundleVersionLabel(bundle('custom', 'v3.0.0'))).toBe('v3.0.0');
  });

  it('falls back to the id when it has no known pattern', () => {
    expect(bundleVersionLabel(bundle('nightly-build'))).toBe('nightly-build');
  });
});
