import { describe, expect, it } from 'vitest';
import { OWN_NORMAL, ownDirection, ownPercentile, percentileAmong, standing } from './own-normal';
import { eligibleFromMetric } from './signals';

describe('percentileAmong', () => {
  it('ranks a value among earlier ones, counting ties as half', () => {
    expect(percentileAmong([1, 2, 3, 4], 2.5)).toBe(0.5);
    expect(percentileAmong([1, 2, 3, 4], 5)).toBe(1);
    expect(percentileAmong([1, 2, 3, 4], 0.5)).toBe(0);
    expect(percentileAmong([1, 2, 2, 4], 2)).toBe(0.5); // one below, two equal
    expect(percentileAmong([], 1)).toBeNull();
  });
});

describe('ownPercentile', () => {
  const steady = Array.from({ length: 60 }, (_, i) => 1.4 + 0.002 * i); // a name that always runs put-heavy: 1.40–1.52

  it('has no normal before enough sessions are on record', () => {
    expect(ownPercentile(steady.slice(0, OWN_NORMAL.minObs - 1), 1.5)).toBeNull();
    expect(ownPercentile(steady.slice(0, OWN_NORMAL.minObs), 1.5)).not.toBeNull();
    expect(ownPercentile(steady, null)).toBeNull();
  });

  it('judges a level against the name’s own history, not a fixed band', () => {
    // 1.45 is "extreme" by the fixed 1.3 band — and squarely in the middle for this name.
    const usual = ownPercentile(steady, 1.45)!;
    expect(usual).toBeGreaterThan(0.3);
    expect(usual).toBeLessThan(0.7);
    expect(ownDirection(usual)).toBeNull();
    // 1.60 is beyond anything it has done: unusually put-heavy for it.
    expect(ownDirection(ownPercentile(steady, 1.6))).toBe('bearish');
    // 1.20 is below its whole history — unusually call-heavy for it, though still above 1.
    expect(ownDirection(ownPercentile(steady, 1.2))).toBe('bullish');
  });

  it('looks back a fixed number of sessions, so an old regime ages out', () => {
    const history = [
      ...Array.from({ length: 200 }, () => 0.5),
      ...Array.from({ length: OWN_NORMAL.lookback }, (_, i) => 1.4 + 0.001 * i),
    ];
    expect(ownPercentile(history, 1.3)).toBe(0); // below everything in the window: the 0.5 era no longer counts
  });

  it('fires only at or beyond the cutoffs', () => {
    expect(ownDirection(OWN_NORMAL.high)).toBe('bearish');
    expect(ownDirection(OWN_NORMAL.high - 0.001)).toBeNull();
    expect(ownDirection(OWN_NORMAL.low)).toBe('bullish');
    expect(ownDirection(OWN_NORMAL.low + 0.001)).toBeNull();
    expect(ownDirection(null)).toBeNull();
  });
});

describe('standing', () => {
  const range = { lo: 1.2, mid: 1.4, hi: 1.6, n: 80 };
  it('places a live value against the usual range', () => {
    expect(standing(1.7, range)).toBe('high');
    expect(standing(1.1, range)).toBe('low');
    expect(standing(1.6, range)).toBe('normal');
    expect(standing(null, range)).toBeNull();
    expect(standing(1.4, null)).toBeNull();
  });
});

describe('eligibility', () => {
  it('counts a day toward pc_own only when the name had a normal that day', () => {
    const day = { putOI: 1000, callOI: 800, spikeBaselineDays: 0 };
    expect(eligibleFromMetric(day)).toEqual(['pc_extreme']);
    expect(eligibleFromMetric({ ...day, oiPcPct: null })).toEqual(['pc_extreme']);
    expect(eligibleFromMetric({ ...day, oiPcPct: 0.5 })).toEqual(['pc_extreme', 'pc_own']);
    expect(eligibleFromMetric({ ...day, oiPcPct: 0 })).toEqual(['pc_extreme', 'pc_own']); // a percentile of zero is still a normal
  });
});
