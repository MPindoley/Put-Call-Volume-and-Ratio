import { describe, expect, it } from 'vitest';
import {
  assignTiers,
  DEFAULT_SCHEDULE,
  MIN_INTERVAL_MS,
  planRefresh,
  targetIntervals,
  type RefreshCandidate,
} from './refresh-schedule';

const MIN = 60_000;
const NOW = 10_000 * MIN;

function universe(n: number, lastFetched = NOW - 5 * MIN): RefreshCandidate[] {
  // Activity falls with index: name 0 is the busiest.
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${String(i).padStart(4, '0')}`,
    lastFetched,
    activity: 1_000_000 / (i + 1),
    watch: false,
    spiking: false,
    benchmark: false,
  }));
}

describe('assignTiers', () => {
  it('ranks by activity into tiers 1/2/3', () => {
    const tiers = assignTiers(universe(1000));
    expect(tiers.get('S0000')).toBe(1);
    expect(tiers.get('S0099')).toBe(1);
    expect(tiers.get('S0100')).toBe(2);
    expect(tiers.get('S0399')).toBe(2);
    expect(tiers.get('S0400')).toBe(3);
  });

  it('pins watchlist, spiking and benchmark names to tier 1 regardless of activity', () => {
    const u = universe(1000);
    u[900] = { ...u[900]!, watch: true };
    u[901] = { ...u[901]!, spiking: true };
    u[902] = { ...u[902]!, benchmark: true };
    const tiers = assignTiers(u);
    expect([tiers.get('S0900'), tiers.get('S0901'), tiers.get('S0902')]).toEqual([1, 1, 1]);
  });

  it('treats names with no known activity as quiet until measured', () => {
    const u = universe(1000);
    u[5] = { ...u[5]!, activity: 0 };
    expect(assignTiers(u).get('S0005')).toBe(3);
  });
});

describe('targetIntervals', () => {
  it('scales intervals so total demand matches the budget', () => {
    const u = universe(1400);
    for (const perMinute of [60, 90, 120]) {
      const intervals = targetIntervals(u, perMinute);
      const demand = u.reduce((s, c) => s + MIN / intervals.get(c.symbol)!, 0);
      expect(demand).toBeCloseTo(perMinute, 0);
    }
  });

  it('keeps tiers in proportion: busy names refresh ~10× as often as the long tail', () => {
    const intervals = targetIntervals(universe(1400), 90);
    const ratio = intervals.get('S1300')! / intervals.get('S0000')!;
    expect(ratio).toBeCloseTo(DEFAULT_SCHEDULE.baseIntervalsMs[2] / DEFAULT_SCHEDULE.baseIntervalsMs[0], 5);
  });

  it('gives a 1,400-name universe at 90/min a few minutes for the busiest and about half an hour for the tail', () => {
    const intervals = targetIntervals(universe(1400), 90);
    expect(intervals.get('S0000')! / MIN).toBeGreaterThan(2.5);
    expect(intervals.get('S0000')! / MIN).toBeLessThan(4.5);
    expect(intervals.get('S1300')! / MIN).toBeLessThan(45);
  });

  it('never asks for fresher than the source can produce', () => {
    const intervals = targetIntervals(universe(10), 600);
    for (const v of intervals.values()) expect(v).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });
});

describe('planRefresh', () => {
  it('respects the budget', () => {
    expect(planRefresh(universe(500), 30, 60, NOW)).toHaveLength(30);
    expect(planRefresh(universe(500), 0, 60, NOW)).toHaveLength(0);
  });

  it('treats a never-seen name as fetched at startup, winning ties', () => {
    // Same tier for everyone; all fetched at startup except one never seen.
    const start = NOW - 2 * MIN;
    const u = universe(500, start).map((c) => ({ ...c, activity: 0 }));
    u[450] = { ...u[450]!, lastFetched: 0 };
    expect(planRefresh(u, 5, 60, NOW, undefined, start)[0]?.symbol).toBe('S0450');
  });

  it('fills the never-fetched backlog instead of re-fetching names that are not yet due', () => {
    // 2 minutes after startup the first 100 were fetched at startup (not due again
    // until ~3 minutes); 1,300 have never been fetched.
    const start = NOW - 2 * MIN;
    const u = universe(1400, 0).map((c, i) => (i < 100 ? { ...c, lastFetched: start } : c));
    const picked = planRefresh(u, 45, 90, NOW, undefined, start).map((p) => p.symbol);
    expect(picked.every((s) => Number(s.slice(1)) >= 100)).toBe(true);
  });

  it('lets a never-seen quiet name wait while busy names are due', () => {
    const start = NOW - 10 * MIN;
    const u = universe(1400, NOW - 4 * MIN); // busy names ~1.2× their interval
    u[1300] = { ...u[1300]!, lastFetched: 0 }; // quiet, never seen: 10 of ~32 minutes
    expect(planRefresh(u, 1, 90, NOW, undefined, start)[0]?.symbol).toBe('S0000');
  });

  it('at startup, takes the busiest never-seen names first', () => {
    const u = universe(1400, 0);
    const picked = planRefresh(u, 45, 90, NOW, undefined, NOW).map((p) => p.symbol);
    expect(picked[0]).toBe('S0000');
    expect(picked.every((s) => Number(s.slice(1)) < 100)).toBe(true); // all tier 1
  });

  it('keeps busy names on schedule during the first pass instead of only filling the tail', () => {
    // 6 minutes after startup: the busiest 100 were fetched at startup (now ~2× their
    // 3-minute interval); everything else has never been fetched.
    const start = NOW - 6 * MIN;
    const u = universe(1400, 0).map((c, i) => (i < 100 ? { ...c, lastFetched: start } : c));
    const picked = planRefresh(u, 45, 90, NOW, undefined, start).map((p) => p.symbol);
    expect(picked[0]).toBe('S0000');
    expect(picked.every((s) => Number(s.slice(1)) < 100)).toBe(true);
  });

  it('still covers the never-seen tail within about one tail interval', () => {
    // 40 minutes after startup a never-seen quiet name is more overdue than a busy name just short of due.
    const start = NOW - 40 * MIN;
    const u = universe(1400, NOW - 3 * MIN);
    u[1300] = { ...u[1300]!, lastFetched: 0 };
    expect(planRefresh(u, 1, 90, NOW, undefined, start)[0]?.symbol).toBe('S1300');
  });

  it('prefers a busy name a few minutes stale over a quiet name far staler', () => {
    const u = universe(1400);
    u[0] = { ...u[0]!, lastFetched: NOW - 8 * MIN }; // tier 1, well past its interval
    u[1300] = { ...u[1300]!, lastFetched: NOW - 25 * MIN }; // tier 3, not yet due
    const picked = planRefresh(u, 1, 90, NOW).map((p) => p.symbol);
    expect(picked).toEqual(['S0000']);
  });

  it('serves the watchlist with the highest priority', () => {
    const u = universe(100);
    u[50] = { ...u[50]!, watch: true, lastFetched: NOW - 10 * MIN };
    const item = planRefresh(u, 100, 60, NOW).find((p) => p.symbol === 'S0050');
    expect(item?.priority).toBe(1);
  });
});
