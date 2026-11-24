import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  OTHER_COLOR,
  SERIES_COLORS,
  awardToastText,
  cumulativeLine,
  dailyGain,
  formatScore,
  meanRange,
  parseQaUpdate,
  pointsOnDay,
  scoreboardDays,
  scoreboardStart,
  smoothCurve,
  smoothTotalLine,
  fixStripLayout,
  fixStripRow,
  spreadLabels,
  totalAt,
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

describe('smoothCurve', () => {
  it('passes through every point and never overshoots a running total', () => {
    const xs = [0, 10, 20, 30, 40];
    const ys = [0, 0, 5, 5, 9];
    const curve = smoothCurve(xs, ys, 8);

    xs.forEach((x, index) => {
      const at = curve.x.indexOf(x);
      expect(curve.y[at]).toBeCloseTo(ys[index]);
    });
    // Monotone: never dips, flat stretches stay flat.
    curve.y
      .slice(1)
      .forEach((y, index) =>
        expect(y).toBeGreaterThanOrEqual(curve.y[index] - 1e-9),
      );
    curve.x.forEach((x, index) => {
      if (x > 0 && x < 10) {
        expect(curve.y[index]).toBeCloseTo(0);
      }
    });
  });

  it('leaves two points alone', () => {
    expect(smoothCurve([0, 1], [3, 4])).toEqual({ x: [0, 1], y: [3, 4] });
  });
});

describe('smoothTotalLine', () => {
  it('holds the total until shortly before each fix and ends at the sum', () => {
    const start = '2026-11-01T00:00:00Z';
    const end = '2026-11-11T00:00:00Z';
    const line = smoothTotalLine(
      [award('2026-11-06T00:00:00Z', 4)],
      start,
      end,
    );
    const fix = Date.parse('2026-11-06T00:00:00Z');

    expect(line.y[0]).toBe(0);
    expect(line.y[line.y.length - 1]).toBe(4);
    // Days before the fix: still 0 (no ramp over the whole gap).
    line.x.forEach((x, index) => {
      if (x < fix - 2 * 24 * 3600 * 1000) {
        expect(line.y[index]).toBeCloseTo(0);
      }
    });
  });
});

describe('spreadLabels', () => {
  it('moves overlapping labels apart and keeps the others', () => {
    expect(spreadLabels([100, 102, 40], 14, 0, 200)).toEqual([100, 114, 40]);
  });

  it('stays within the plot - pushed down from the top', () => {
    expect(spreadLabels([198, 199, 200], 10, 0, 200)).toEqual([180, 190, 200]);
  });
});

describe('daily figures', () => {
  const board: Scoreboard = {
    mean: [{ day: '2026-11-08', score: 60, locations: 3 }],
    users: [
      user(1, [
        award('2026-11-09T10:00:00', 4),
        award('2026-11-18T09:00:00', 2.5),
      ]),
    ],
    unattributed: { total: 0, count: 0 },
    now: '2026-11-18T12:00:00',
  };

  it('averages the points over the days of the scoreboard', () => {
    const days = scoreboardDays(board);
    expect(days).toBe(11);
    expect(dailyGain(board.users[0], days)).toBe(0.59);
  });

  it('counts the points of the current day and the total at a time', () => {
    expect(pointsOnDay(board.users[0], board.now)).toBe(2.5);
    expect(
      totalAt(board.users[0].awards, Date.parse('2026-11-10T00:00:00')),
    ).toBe(4);
  });
});

describe('fixStripLayout', () => {
  const margin = { t: 10, b: 28 };

  it('keeps the lines as high as without the strip and puts the strip below', () => {
    const layout = fixStripLayout(4, 240, margin);
    const area = layout.height - margin.t - margin.b;

    // 4 rows of 9px + 8px, the gap of 20px on top of the 240px.
    expect(layout.height).toBe(240 + 44 + 20);
    expect((layout.lines[1] - layout.lines[0]) * area).toBeCloseTo(240 - 38);
    expect(layout.strip[0]).toBe(0);
    expect(layout.strip[1] * area).toBeCloseTo(44);
    // The strip's title between the two.
    expect(layout.title).toBeGreaterThan(layout.strip[1]);
    expect(layout.title).toBeLessThan(layout.lines[0]);
  });

  it('stops growing with many staff members - and has a row without any', () => {
    expect(fixStripLayout(30, 240, margin).height).toBe(fixStripLayout(12, 240, margin).height);
    expect(fixStripLayout(0, 240, margin).height).toBe(fixStripLayout(1, 240, margin).height);
  });

  it('puts the first staff member on top', () => {
    expect([0, 1, 2].map((index) => fixStripRow(index, 3))).toEqual([2, 1, 0]);
  });
});
