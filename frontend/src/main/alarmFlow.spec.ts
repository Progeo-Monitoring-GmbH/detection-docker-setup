import { describe, expect, it } from 'vitest';
import {
  durationParts,
  mailOutcome,
  minutesUntil,
  nowIndex,
  relativeDay,
  type FlowPoint,
} from './alarmFlow';

const NOW = new Date(2026, 10, 21, 16, 25).getTime();
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

describe('nowIndex', () => {
  it('stands before the first planned stage, else at the end', () => {
    const detected: FlowPoint = { type: 'detected', at: local(21, 14, 2) };
    const planned = { type: 'planned', stage: 2 } as FlowPoint;
    expect(nowIndex([detected, { type: 'sent' } as FlowPoint, planned, planned])).toBe(2);
    expect(nowIndex([detected])).toBe(1);
  });
});

describe('minutesUntil and durationParts', () => {
  it('counts down to the next message', () => {
    expect(minutesUntil(local(21, 18, 5), NOW)).toBe(100);
    expect(minutesUntil(local(21, 16, 0), NOW)).toBe(-25);
  });

  it('keeps the two largest parts', () => {
    expect(durationParts(100)).toEqual({ hours: 1, minutes: 40 });
    expect(durationParts(1300)).toEqual({ hours: 21, minutes: 40 });
    expect(durationParts(3 * 1440 + 125)).toEqual({ days: 3, hours: 2 });
    expect(durationParts(7)).toEqual({ minutes: 7 });
    expect(durationParts(-5)).toEqual({ minutes: 0 });
  });
});

describe('relativeDay', () => {
  it('names today, tomorrow and yesterday by the calendar day, not 24 hours', () => {
    expect(relativeDay(local(21, 23, 59), NOW)).toBe('today');
    expect(relativeDay(local(22, 0, 1), NOW)).toBe('tomorrow');
    expect(relativeDay(local(20, 9), NOW)).toBe('yesterday');
    expect(relativeDay(local(24, 9), NOW)).toBeNull();
  });
});

describe('mailOutcome', () => {
  it('tells sent, failed and held back mails apart', () => {
    expect(mailOutcome('sent')).toBe('ok');
    expect(['bounced', 'failed', 'suppressed', 'rate_limited', 'blocked'].map(mailOutcome)).toEqual(
      ['fail', 'fail', 'fail', 'fail', 'fail'],
    );
    expect(['withheld', 'dry_run'].map(mailOutcome)).toEqual(['held', 'held']);
  });
});
