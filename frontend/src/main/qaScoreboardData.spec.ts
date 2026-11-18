import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  OTHER_COLOR,
  SERIES_COLORS,
  awardToastText,
  cumulativeLine,
  formatScore,
  meanRange,
  parseQaUpdate,
  scoreboardStart,
  userColors,
  type QaAward,
  type QaUser,
  type Scoreboard,
} from './qaScoreboardData';

const award = (
  at: string,
  points: number,
  check_key = 'heat_limitation',
): QaAward => ({
  at,
  points,
  check_key,
  location_id: 7,
  project_id: 4700,
  location_name: 'Halle 1',
});

const user = (id: number, awards: QaAward[] = []): QaUser => ({
  id,
  username: `staff${id}`,
  total: awards.reduce((sum, entry) => sum + entry.points, 0),
  count: awards.length,
  awards,
});

// t() returning the key and its options - enough to see what is asked for.
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('userColors', () => {
  it('gives the scorers the series hues by user id, so a colour stays with its person', () => {
    const colors = userColors([
      user(9, [award('2026-11-01T10:00:00Z', 5)]),
      user(3, [award('2026-11-02T10:00:00Z', 1)]),
      user(5),
    ]);

    expect([...colors]).toEqual([
      [3, SERIES_COLORS[0]],
      [9, SERIES_COLORS[1]],
    ]);
  });

  it('never cycles the hues - staff beyond the palette share the neutral colour', () => {
    const scorers = Array.from(
      { length: SERIES_COLORS.length + 2 },
      (_, index) => user(index + 1, [award('2026-11-01T10:00:00Z', 1)]),
    );

    const colors = userColors(scorers);

    expect(colors.get(SERIES_COLORS.length)).toBe(
      SERIES_COLORS[SERIES_COLORS.length - 1],
    );
    expect(colors.get(SERIES_COLORS.length + 1)).toBe(OTHER_COLOR);
    expect(colors.get(SERIES_COLORS.length + 2)).toBe(OTHER_COLOR);
  });
});

describe('cumulativeLine', () => {
  it('starts at 0, steps up at each fix in time order and holds the total until the end', () => {
    const later = award('2026-11-03T10:00:00Z', 2.5);
    const earlier = award('2026-11-02T10:00:00Z', 4.25);

    const line = cumulativeLine(
      [later, earlier],
      '2026-11-01T00:00:00Z',
      '2026-11-05T00:00:00Z',
    );

    expect(line.x).toEqual([
      '2026-11-01T00:00:00Z',
      earlier.at,
      later.at,
      '2026-11-05T00:00:00Z',
    ]);
    expect(line.y).toEqual([0, 4.3, 6.8, 6.8]);
    expect(line.awards).toEqual([null, earlier, later, null]);
  });
});

describe('scoreboardStart', () => {
  const board = (mean: Scoreboard['mean'], users: QaUser[]): Scoreboard => ({
    mean,
    users,
    unattributed: { total: 0, count: 0 },
    now: '2026-11-18T12:00:00Z',
  });

  it('is the earlier of the first mean day and the first fix', () => {
    const start = scoreboardStart(
      board(
        [{ day: '2026-11-10', score: 60, locations: 3 }],
        [user(1, [award('2026-11-08T09:00:00Z', 1)])],
      ),
    );

    expect(start).toBe('2026-11-08T09:00:00.000Z');
  });

  it('is now without any data', () => {
    expect(scoreboardStart(board([], [user(1)]))).toBe(
      '2026-11-18T12:00:00.000Z',
    );
  });
});

describe('awardToastText', () => {
  it('names the check and location of a single fix', () => {
    const text = awardToastText(t, [
      { id: 1, ...award('2026-11-18T10:00:00Z', 2.7) },
    ]);

    expect(text).toContain('qa_toast_one');
    expect(text).toContain('readiness_check_heat_limitation · Halle 1 (#4700)');
  });

  it('sums several fixes', () => {
    const text = awardToastText(t, [
      { id: 1, ...award('2026-11-18T10:00:00Z', 2.5) },
      { id: 2, ...award('2026-11-18T10:00:00Z', 1.5, 'product') },
    ]);

    expect(text).toBe(
      `qa_toast_many ${JSON.stringify({ points: '4', count: 2 })}`,
    );
  });
});

describe('formatScore', () => {
  // The browser's number format: "64.0" or "64,0".
  it('shows one decimal, the change with its sign', () => {
    expect(formatScore(64)).toMatch(/^64[.,]0$/);
    expect(formatScore(2.46, true)).toMatch(/^\+2[.,]5$/);
    expect(formatScore(-1.2, true)).toMatch(/^−1[.,]2$/);
  });
});

describe('meanRange', () => {
  it('fits the scores with some room, within 0..100', () => {
    expect(meanRange([60, 64])).toEqual([58, 66]);
    expect(meanRange([1, 99])).toEqual([0, 100]);
    expect(meanRange([])).toEqual([0, 100]);
  });
});

describe('parseQaUpdate', () => {
  it('reads the point changes of the socket and ignores everything else', () => {
    expect(
      parseQaUpdate(
        JSON.stringify({
          type: 'qa_update',
          user_ids: [4, 'x'],
          reason: 'revoke',
        }),
      ),
    ).toEqual({
      user_ids: [4],
      reason: 'revoke',
    });
    expect(parseQaUpdate(JSON.stringify({ type: 'heartbeat' }))).toBeNull();
    expect(parseQaUpdate('not json')).toBeNull();
    expect(parseQaUpdate(undefined)).toBeNull();
  });
});
