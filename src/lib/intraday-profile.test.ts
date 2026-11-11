import { describe, expect, it } from 'vitest';
import {
  BUCKETS,
  bucketVolumes,
  CLOCK_PARAMS,
  dayTypeOf,
  DEFAULT_INTRADAY_SHAPE,
  expectedFraction,
  foldSession,
  reactionSessions,
  resolveClocks,
  sessionShape,
  shapePutShare,
  shapeTotals,
  type ProfileRow,
  type Shape,
  type VolumePoint,
} from './intraday-profile';
import { isLastSessionOfWeek, sessionBounds } from './trading-calendar';

const OPEN = sessionBounds('2026-11-04')!.openMs; // a Wednesday
const MIN = 60_000;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Cumulative points every `step` minutes for a day whose half-hour bucket volumes are `perBucket` (60% calls). */
function day(perBucket: readonly number[], step = 5, until = 390): VolumePoint[] {
  const out: VolumePoint[] = [];
  const minutes: number[] = [];
  for (let m = step; m < until; m += step) minutes.push(m);
  minutes.push(until); // always a snapshot at the end
  for (const m of minutes) {
    let cum = 0;
    for (let b = 0; b < BUCKETS; b++) cum += perBucket[b]! * Math.min(1, Math.max(0, (m - b * 30) / 30));
    out.push({ t: OPEN + m * MIN, put: cum * 0.4, call: cum * 0.6 });
  }
  return out;
}

describe('calendar: kinds of day', () => {
  it('finds the last session of the week, moving to Thursday when Friday is a holiday', () => {
    expect(isLastSessionOfWeek('2026-11-06')).toBe(true); // Friday
    expect(isLastSessionOfWeek('2026-11-05')).toBe(false);
    expect(isLastSessionOfWeek('2026-04-02')).toBe(true); // Thursday before Good Friday
    expect(isLastSessionOfWeek('2026-04-03')).toBe(false); // Good Friday itself: no session
  });

  it('classifies a day for a name: earnings wins over expiry', () => {
    expect(dayTypeOf('2026-11-04')).toBe('regular');
    expect(dayTypeOf('2026-11-06')).toBe('expiry');
    expect(dayTypeOf('2026-11-06', new Set(['2026-11-06']))).toBe('earnings');
  });

  it('places the earnings reaction on the right session', () => {
    expect(reactionSessions('2026-11-04', 'bmo')).toEqual(['2026-11-04']);
    expect(reactionSessions('2026-11-04', 'amc')).toEqual(['2026-11-05']);
    expect(reactionSessions('2026-11-06', 'amc')).toEqual(['2026-11-09']); // Friday evening → Monday
    expect(reactionSessions('2026-11-04', 'unknown')).toEqual(['2026-11-04', '2026-11-05']);
    expect(reactionSessions('2026-11-07', 'bmo')).toEqual(['2026-11-09']); // dated on a Saturday
  });
});

describe('expectedFraction', () => {
  const flat = new Array<number>(BUCKETS).fill(1 / BUCKETS);
  it('interpolates inside a half hour instead of stepping at its start', () => {
    expect(expectedFraction(flat, 60)).toBeCloseTo(2 / 13, 9);
    expect(expectedFraction(flat, 75)).toBeCloseTo(2.5 / 13, 9);
    expect(expectedFraction(flat, 390)).toBeCloseTo(1, 9);
    expect(expectedFraction(flat, 600)).toBeCloseTo(1, 9); // after the close
  });
  it('never judges the opening minutes against less than the first half hour', () => {
    expect(expectedFraction(DEFAULT_INTRADAY_SHAPE, 1)).toBeCloseTo(0.14, 9);
    expect(expectedFraction(DEFAULT_INTRADAY_SHAPE, -20)).toBeCloseTo(0.14, 9);
    const lateTrader = [0.01, 0.01, ...new Array<number>(11).fill(0.98 / 11)];
    expect(expectedFraction(lateTrader, 10)).toBe(CLOCK_PARAMS.minFraction);
  });
});

describe('bucketVolumes', () => {
  const perBucket = [300, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 100];

  it('recovers each half hour from cumulative snapshots', () => {
    const v = bucketVolumes(day(perBucket), OPEN)!;
    expect(v.complete).toBe(true);
    expect(v.put.map((p, i) => Math.round(p! + v.call[i]!))).toEqual(perBucket);
    expect(v.put[0]! / (v.put[0]! + v.call[0]!)).toBeCloseTo(0.4, 6);
  });

  it('interpolates across sparse snapshots and reports the widest gap it crossed', () => {
    const v = bucketVolumes(day(perBucket, 45), OPEN)!; // a quiet name, refreshed every 45 min
    expect(sum(v.put.map((x) => x!)) + sum(v.call.map((x) => x!))).toBeCloseTo(sum(perBucket), 6);
    expect(v.worstGapMin).toBe(45);
  });

  it('stops where a running session stops: later half hours are unknown', () => {
    const v = bucketVolumes(day(perBucket, 5, 100), OPEN)!; // data through 11:10
    expect(v.complete).toBe(false);
    expect(v.throughMin).toBe(100);
    expect(Math.round(v.put[2]! + v.call[2]!)).toBe(50); // 10:30–11:00, whole
    expect(Math.round(v.put[3]! + v.call[3]!)).toBe(17); // 11:00–11:30, ten minutes in
    expect(v.put[4]).toBeNull();
  });

  it('drops a carried-over total from before the feed reset, but keeps the running high on a later correction', () => {
    const stale: VolumePoint = { t: OPEN + 2 * MIN, put: 40_000, call: 60_000 }; // yesterday's totals at 9:32
    const reset = bucketVolumes([stale, ...day(perBucket)], OPEN)!;
    expect(Math.round(reset.put[0]! + reset.call[0]!)).toBe(300);
    const points = day(perBucket);
    points[40] = { ...points[40]!, put: 1, call: 1 }; // a bad print mid-afternoon
    const corrected = bucketVolumes(points, OPEN)!;
    expect(sum(corrected.put.map((x) => x!)) + sum(corrected.call.map((x) => x!))).toBeCloseTo(sum(perBucket), 6);
  });

  it('takes the day total from a snapshot after the bell', () => {
    const points = [...day(perBucket, 5, 385), { t: OPEN + 410 * MIN, put: 480, call: 720 }]; // late prints: 1,200 in all
    const v = bucketVolumes(points, OPEN)!;
    expect(v.complete).toBe(true);
    expect(sum(v.put.map((x) => x!)) + sum(v.call.map((x) => x!))).toBeCloseTo(1_200, 6);
  });

  it('returns null with nothing inside the session', () => {
    expect(bucketVolumes([{ t: OPEN - 5 * MIN, put: 5, call: 5 }], OPEN)).toBeNull();
  });
});

describe('sessionShape', () => {
  const perBucket = [300, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 100];
  it('gives shares of the day that sum to one', () => {
    const s = sessionShape(day(perBucket), OPEN)!;
    expect(sum(s.put) + sum(s.call)).toBeCloseTo(1, 9);
    expect(s.put[0]! + s.call[0]!).toBeCloseTo(0.3, 6);
  });
  it('refuses a session it cannot measure: unfinished, gappy or too thin', () => {
    expect(sessionShape(day(perBucket, 5, 300), OPEN)).toBeNull(); // stops at 14:30
    expect(sessionShape(day(perBucket, 130), OPEN)).toBeNull(); // 130-minute gaps
    expect(sessionShape(day(perBucket.map((x) => x / 10)), OPEN)).toBeNull(); // 100 contracts all day
    const lunchOutage = day(perBucket).filter((p) => p.t < OPEN + 120 * MIN || p.t > OPEN + 240 * MIN);
    expect(sessionShape(lunchOutage, OPEN)).toBeNull();
  });
});

describe('foldSession', () => {
  const shape = (first: number): Shape => {
    const rest = (1 - first) / 12;
    const totals = [first, ...new Array<number>(12).fill(rest)];
    return { put: totals.map((x) => x * 0.5), call: totals.map((x) => x * 0.5) };
  };
  it('keeps a recency-weighted mean: newer sessions count more', () => {
    let p = foldSession(null, shape(0.1), 2);
    expect(p.weight).toBe(1);
    p = foldSession(p, shape(0.4), 2);
    const decay = Math.pow(0.5, 0.5);
    expect(p.weight).toBeCloseTo(1 + decay, 9);
    expect(p.sessions).toBe(2);
    const mean = (p.putSum[0]! + p.callSum[0]!) / p.weight;
    expect(mean).toBeCloseTo((0.4 + 0.1 * decay) / (1 + decay), 9);
    expect(mean).toBeGreaterThan(0.25); // above the plain average
  });
});

describe('resolveClocks', () => {
  const totalsShape = (totals: number[]): Shape => ({ put: totals.map((x) => x * 0.4), call: totals.map((x) => x * 0.6) });
  const front = [0.4, ...new Array<number>(12).fill(0.05)];
  const back = [...new Array<number>(12).fill(0.05), 0.4];
  const flat = new Array<number>(13).fill(1 / 13);
  const row = (symbol: string, dayType: ProfileRow['dayType'], totals: number[], sessions: number): ProfileRow => {
    const s = totalsShape(totals);
    return {
      symbol,
      dayType,
      putSum: s.put.map((x) => x * sessions),
      callSum: s.call.map((x) => x * sessions),
      weight: sessions,
      sessions,
    };
  };
  const universe = [
    { symbol: 'AAA', sector: 'Tech' },
    { symbol: 'BBB', sector: 'Tech' },
    { symbol: 'NEW', sector: 'Tech' },
    { symbol: 'EEE', sector: 'Energy' },
  ];
  const prior = { all: 1, sector: 1, stock: 10, type: 8 };

  it('gives a name with history its own clock and a new name its sector’s', () => {
    const book = resolveClocks(
      [row('AAA', 'regular', front, 90), row('BBB', 'regular', back, 90), row('EEE', 'regular', flat, 90)],
      universe,
      prior,
    );
    const aaa = shapeTotals(book.stocks.get('AAA')!.shapes.regular);
    expect(aaa[0]).toBeGreaterThan(0.35); // 90 sessions against a prior of 10: mostly its own
    expect(book.stocks.get('AAA')!.ownShare).toBeCloseTo(0.9, 9);
    const fresh = book.stocks.get('NEW')!;
    expect(fresh.ownShare).toBe(0);
    expect(shapeTotals(fresh.shapes.regular)).toEqual(shapeTotals(book.sectors.get('Tech')!.regular));
    // Tech pools AAA and BBB: both ends heavy, unlike flat Energy.
    expect(shapeTotals(book.sectors.get('Tech')!.regular)[0]).toBeGreaterThan(
      shapeTotals(book.sectors.get('Energy')!.regular)[0]! * 2,
    );
    for (const c of book.stocks.values()) expect(sum(shapeTotals(c.shapes.regular))).toBeCloseTo(1, 9);
  });

  it('weighs a few sessions against the sector in proportion to the evidence', () => {
    const book = resolveClocks([row('AAA', 'regular', front, 10), row('BBB', 'regular', flat, 500)], universe, prior);
    const sector = shapeTotals(book.sectors.get('Tech')!.regular)[0]!;
    const aaa = shapeTotals(book.stocks.get('AAA')!.shapes.regular)[0]!;
    expect(aaa).toBeCloseTo((0.4 + sector) / 2, 2); // 10 sessions vs a prior of 10: halfway
  });

  it('bends a name’s own clock the way that kind of day bends its sector’s, until the name has its own', () => {
    const rows = [
      row('AAA', 'regular', front, 90),
      row('BBB', 'regular', flat, 90),
      row('BBB', 'expiry', back, 90), // the sector's expiry days are back-loaded
    ];
    const book = resolveClocks(rows, universe, prior);
    const aaa = book.stocks.get('AAA')!;
    const regular = shapeTotals(aaa.shapes.regular);
    const expiry = shapeTotals(aaa.shapes.expiry);
    expect(aaa.own.expiry.sessions).toBe(0);
    expect(expiry[12]! / regular[12]!).toBeGreaterThan(1.5); // more at the close than on its regular days
    expect(expiry[0]).toBeGreaterThan(expiry[6]!); // …and still front-loaded, like the name itself
    expect(sum(expiry)).toBeCloseTo(1, 9);
    // With no earnings days on record anywhere, an earnings day reads as a regular one.
    expect(shapeTotals(aaa.shapes.earnings)[0]).toBeCloseTo(regular[0]!, 6);
  });

  it('starts from the fixed curve when nothing is learned, and carries the put/call mix', () => {
    const empty = resolveClocks([], universe);
    expect(shapeTotals(empty.all.regular)[0]).toBeCloseTo(DEFAULT_INTRADAY_SHAPE[0], 9);
    const book = resolveClocks([row('AAA', 'regular', front, 90)], universe, prior);
    expect(shapePutShare(book.stocks.get('AAA')!.shapes.regular)[0]).toBeCloseTo(0.4, 2);
  });
});
