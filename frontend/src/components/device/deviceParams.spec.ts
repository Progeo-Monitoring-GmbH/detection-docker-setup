import { describe, expect, it } from 'vitest';
import { paramOptionsFor } from './deviceParams';

const values = (key: string, isM5: boolean) => paramOptionsFor(key, isM5).map((option) => option.value);

describe('paramOptionsFor', () => {
  it('drops pulldown 8 for the M5', () => {
    expect(values('pulldown_resistance', true)).toEqual([136, 72, 40, 24]);
    expect(values('pulldown_resistance', false)).toContain(8);
  });

  it('drops poll 0 for the M5', () => {
    expect(values('poll_sec', true)).not.toContain(0);
    expect(values('poll_sec', false)).toContain(0);
  });

  it('leaves other parameters unchanged', () => {
    expect(values('interval_sec', true)).toEqual(values('interval_sec', false));
  });
});
