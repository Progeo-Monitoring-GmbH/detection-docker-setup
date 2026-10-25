import { describe, expect, it } from 'vitest';
import {
  backupListQuery,
  createBackupBody,
  filterValueOf,
  parseDateFilter,
  parseProjectFilter,
  projectLabel,
  projectOfFilter,
} from './backupProjects';

const t = (key: string) => key;

describe('backup project filter', () => {
  it('maps backend projects to filter values', () => {
    expect(filterValueOf(null)).toBe('default');
    expect(filterValueOf('unknown')).toBe('unknown');
    expect(filterValueOf(4711)).toBe('4711');
  });

  it('only accepts known filter values from the URL', () => {
    expect(parseProjectFilter('4711')).toBe('4711');
    expect(parseProjectFilter('unknown')).toBe('unknown');
    expect(parseProjectFilter('default')).toBe('default');
    expect(parseProjectFilter('drop table')).toBe('');
    expect(parseProjectFilter(null)).toBe('');
  });

  it('turns a filter back into its project', () => {
    expect(projectOfFilter('4711')).toBe(4711);
    expect(projectOfFilter('unknown')).toBe('unknown');
    expect(projectOfFilter('default')).toBeNull();
    expect(projectOfFilter('')).toBeNull();
  });

  it('adds the filter to every list query', () => {
    expect(backupListQuery({ project: '' })).toBe('page_size=1000');
    expect(backupListQuery({ project: '4711' })).toBe('page_size=1000&project=4711');
    expect(backupListQuery({ project: 'unknown' })).toBe('page_size=1000&project=unknown');
    expect(backupListQuery({ project: '', date: '2026-10-24' })).toBe(
      'page_size=1000&date=2026-10-24',
    );
    expect(backupListQuery({ project: '4711', latest: true })).toBe(
      'page_size=1000&project=4711&latest=1',
    );
  });

  it('only accepts ISO days from the URL', () => {
    expect(parseDateFilter('2026-10-24')).toBe('2026-10-24');
    expect(parseDateFilter('24.10.2026')).toBe('');
    expect(parseDateFilter(null)).toBe('');
  });

  it('backs up the selected project database, else default', () => {
    expect(createBackupBody('')).toEqual({});
    expect(createBackupBody('default')).toEqual({});
    expect(createBackupBody('4711')).toEqual({ project: '4711' });
    expect(createBackupBody('unknown')).toEqual({ project: 'unknown' });
  });

  it('labels projects with their location names', () => {
    expect(projectLabel(t, 4711, 'Halle Nord')).toBe('4711 – Halle Nord');
    expect(projectLabel(t, 4711, null)).toBe('4711');
    expect(projectLabel(t, 'unknown')).toBe('backup_project_unknown');
    expect(projectLabel(t, null, null, 'default')).toBe('backup_project_default');
    expect(projectLabel(t, null, null, 'main_db')).toBe('main_db');
  });
});
