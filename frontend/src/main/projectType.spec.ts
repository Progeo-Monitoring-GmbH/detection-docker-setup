import { describe, expect, it, vi } from 'vitest';
import {
  getProjectTypeLabel,
  isLorawanProject,
  PROJECT_TYPE_BRAND_LABELS,
  PROJECT_TYPE_LABEL_KEYS,
} from './projectType';

const t = (key: string) => `t(${key})`;

describe('getProjectTypeLabel', () => {
  it('returns a dash for null/undefined values', () => {
    expect(getProjectTypeLabel(t, null)).toBe('–');
    expect(getProjectTypeLabel(t, undefined)).toBe('–');
    expect(getProjectTypeLabel(t, null, 'Fallback')).toBe('–');
  });

  it('returns brand names literally without translating', () => {
    const spy = vi.fn(t);
    expect(getProjectTypeLabel(spy, 1)).toBe('smartex® dm');
    expect(getProjectTypeLabel(spy, 2)).toBe('geologger');
    expect(getProjectTypeLabel(spy, 3)).toBe('smartex® is');
    expect(getProjectTypeLabel(spy, 6)).toBe('LoRaWan');
    expect(getProjectTypeLabel(spy, 7)).toBe('smartex® mx-PEEL');
    expect(getProjectTypeLabel(spy, 11)).toBe('smartex® vt');
    expect(spy).not.toHaveBeenCalled();
  });

  it('translates generic project types via their i18n keys', () => {
    expect(getProjectTypeLabel(t, 0)).toBe('t(objekt_project_type_unknown)');
    expect(getProjectTypeLabel(t, 4)).toBe('t(objekt_project_type_development)');
    expect(getProjectTypeLabel(t, 5)).toBe('t(objekt_project_type_versuchsprojekte)');
    expect(getProjectTypeLabel(t, 99)).toBe('t(objekt_project_type_sonstige)');
  });

  it('treats 0 as a real value, not as missing', () => {
    expect(getProjectTypeLabel(t, 0)).not.toBe('–');
  });

  it('uses the fallback label for unknown values, else the number itself', () => {
    expect(getProjectTypeLabel(t, 42, 'Backend label')).toBe('Backend label');
    expect(getProjectTypeLabel(t, 42)).toBe('42');
    expect(getProjectTypeLabel(t, 42, null)).toBe('42');
  });

  it('prefers a known label over a given fallback', () => {
    expect(getProjectTypeLabel(t, 1, 'other')).toBe('smartex® dm');
    expect(getProjectTypeLabel(t, 4, 'other')).toBe('t(objekt_project_type_development)');
  });
});

describe('isLorawanProject', () => {
  it('is true only for the LoRaWan project type', () => {
    expect(isLorawanProject(6)).toBe(true);
    [0, 1, 2, 3, 4, 5, 7, 11, 99, null, undefined].forEach((value) =>
      expect(isLorawanProject(value)).toBe(false),
    );
  });
});

describe('project type tables', () => {
  it('brand and i18n tables do not overlap', () => {
    const brand = Object.keys(PROJECT_TYPE_BRAND_LABELS);
    Object.keys(PROJECT_TYPE_LABEL_KEYS).forEach((key) => expect(brand).not.toContain(key));
  });
});
