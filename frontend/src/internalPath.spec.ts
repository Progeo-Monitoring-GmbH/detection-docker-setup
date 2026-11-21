import { describe, expect, it } from 'vitest';
import { internalPath } from './internalPath';

describe('internalPath', () => {
  it('keeps paths of this site', () => {
    expect(internalPath('/location/1/status?view=zeitreihe')).toBe('/location/1/status?view=zeitreihe');
    expect(internalPath('/')).toBe('/');
  });

  it('refuses other origins and anything that is not a path', () => {
    for (const value of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', 'location/1', '', null, undefined, 42]) {
      expect(internalPath(value)).toBeNull();
    }
  });
});
