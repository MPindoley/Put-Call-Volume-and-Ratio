import { describe, expect, it } from 'vitest';
import {
  buildSpikeBook,
  dayPartOf,
  dedupeEpisodes,
  estimate,
  followThrough,
  followThroughNote,
  gradeCloses,
  gradeIntraday,
  leanOf,
  priceNear,
  spikeTable,
  type PricePoint,
  type SpikeObs,
} from './spike-outcomes';

const MIN = 60_000;
const OPEN = Date.UTC(2026, 10, 4, 14, 30); // 9:30 ET
const CLOSE = OPEN + 390 * MIN;
/** A price every 5 minutes: starts at `from`, moves `perMin` per minute. */
const line = (from: number, perMin: number): PricePoint[] =>
  Array.from({ length: 79 }, (_, i) => ({ t: OPEN + i * 5 * MIN, price: from + perMin * i * 5 }));

describe('classification', () => {
  it('splits the session into morning, midday and afternoon', () => {
    expect(dayPartOf(0)).toBe('morning');
    expect(dayPartOf(89)).toBe('morning');
    expect(dayPartOf(90)).toBe('midday');
    expect(dayPartOf(269)).toBe('midday');
    expect(dayPartOf(270)).toBe('afternoon');
    expect(dayPartOf(400)).toBe('afternoon');
  });
  it('reads the lean from the put/call ratio', () => {
    expect(leanOf(1.4)).toBe('puts');
    expect(leanOf(0.6)).toBe('calls');
  });
});

describe('priceNear', () => {
  const series = line(100, 0.01);
  it('takes the nearest stored price within the tolerance', () => {
    expect(priceNear(series, OPEN + 12 * MIN, 10 * MIN)).toBeCloseTo(100.1, 9); // 9:40 is nearer than 9:45
    expect(priceNear(series, OPEN + 13 * MIN, 10 * MIN)).toBeCloseTo(100.15, 9);
    expect(priceNear(series, OPEN - 30 * MIN, 10 * MIN)).toBeNull();
    expect(priceNear([], OPEN, 10 * MIN)).toBeNull();
  });
});

describe('gradeIntraday', () => {
  it('measures the windows from the moment the alert appeared', () => {
    const g = gradeIntraday(OPEN + 60 * MIN, OPEN, CLOSE, line(100, 0.02), line(500, 0.01));
    expect(g.priceAt).toBeCloseTo(101.2, 9);
    expect(g.move30m).toBeCloseTo((101.8 / 101.2 - 1) * 100, 9);
    expect(g.move2h).toBeCloseTo((103.6 / 101.2 - 1) * 100, 9);
    expect(g.spy30m).toBeCloseTo((500.9 / 500.6 - 1) * 100, 9);
  });
  it('does not measure a window that runs past the bell', () => {
    const g = gradeIntraday(OPEN + 300 * MIN, OPEN, CLOSE, line(100, 0.02), line(500, 0.01)); // 2:30pm
    expect(g.move30m).not.toBeNull();
    expect(g.move2h).toBeNull();
    const late = gradeIntraday(OPEN + 375 * MIN, OPEN, CLOSE, line(100, 0.02), line(500, 0.01)); // 3:45pm
    expect(late.move30m).toBeNull();
  });
  it('has no intraday windows after the bell or without a price on record', () => {
    expect(gradeIntraday(CLOSE + 10 * MIN, OPEN, CLOSE, line(100, 0.02), line(500, 0.01)).priceAt).toBeNull();
    const gappy = line(100, 0.02).filter((p) => p.t < OPEN + 30 * MIN || p.t > OPEN + 120 * MIN);
    expect(gradeIntraday(OPEN + 60 * MIN, OPEN, CLOSE, gappy, line(500, 0.01))).toMatchObject({ priceAt: null, move30m: null });
  });
});

describe('gradeCloses', () => {
  const closes = { close: 102, nextClose: 104, spyClose: 505, spyNextClose: 500 };
  it('measures to the settled close and the next session’s', () => {
    const g = gradeCloses({ afterBell: false, priceAt: 100, spyAt: 500, ...closes });
    expect(g.moveClose).toBeCloseTo(2, 9);
    expect(g.moveNext).toBeCloseTo(4, 9);
    expect(g.spyClose).toBeCloseTo(1, 9);
    expect(g.spyNext).toBeCloseTo(0, 9);
  });
  it('starts an after-the-bell alert from the close: only the next day applies', () => {
    const g = gradeCloses({ afterBell: true, priceAt: null, spyAt: null, ...closes });
    expect(g.priceAt).toBe(102);
    expect(g.moveClose).toBeNull();
    expect(g.moveNext).toBeCloseTo((104 / 102 - 1) * 100, 9);
  });
  it('leaves a window unmeasured when a close is missing', () => {
    expect(gradeCloses({ afterBell: false, priceAt: 100, spyAt: 500, ...closes, nextClose: null }).moveNext).toBeNull();
  });
});

let seq = 0;
function obs(over: Partial<SpikeObs> & { signed?: number }): SpikeObs {
  const lean = over.lean ?? 'calls';
  // `signed` = the move in the spike's direction, in excess of a flat SPY.
  const raw = (over.signed ?? 1) * (lean === 'calls' ? 1 : -1);
  seq += 1;
  return {
    symbol: `S${seq}`,
    sector: 'Tech',
    isEtf: false,
    session: '2026-11-04',
    createdAt: OPEN + seq,
    age: 0,
    part: 'morning',
    lean,
    move: { m30: raw, h2: raw, close: raw, next: raw },
    spy: { m30: 0, h2: 0, close: 0, next: 0 },
    ...over,
  };
}
const many = (n: number, over: Partial<SpikeObs> & { signed?: number }): SpikeObs[] => Array.from({ length: n }, () => obs(over));

describe('followThrough', () => {
  it('scores a single name against SPY, in the direction the flow leaned', () => {
    const o = obs({
      lean: 'puts',
      move: { m30: -1, h2: null, close: 0.5, next: 0 },
      spy: { m30: 0.5, h2: 0, close: 0.5, next: null },
    });
    expect(followThrough(o, 'm30')).toBeCloseTo(1.5, 9); // fell 1% while SPY rose 0.5%: the puts were right
    expect(followThrough(o, 'h2')).toBeNull();
    expect(followThrough(o, 'close')).toBeCloseTo(0, 9);
    expect(followThrough(o, 'next')).toBeNull(); // no SPY move to compare with
  });
  it('scores an ETF on its raw move', () => {
    const etf = obs({
      isEtf: true,
      lean: 'calls',
      move: { m30: 0.4, h2: 0.4, close: 0.4, next: 0.4 },
      spy: { m30: null, h2: null, close: null, next: null },
    });
    expect(followThrough(etf, 'm30')).toBeCloseTo(0.4, 9);
  });
});

describe('dedupeEpisodes', () => {
  it('counts a name once per session, part of day and lean: its first alert', () => {
    const a = obs({ symbol: 'AAA', createdAt: OPEN + 5 * MIN, signed: 2 });
    const b = obs({ symbol: 'AAA', createdAt: OPEN + 40 * MIN, signed: -2 });
    const c = obs({ symbol: 'AAA', createdAt: OPEN + 120 * MIN, part: 'midday' });
    const d = obs({ symbol: 'AAA', createdAt: OPEN + 50 * MIN, lean: 'puts' });
    const kept = dedupeEpisodes([b, a, c, d]);
    expect(kept).toHaveLength(3);
    expect(kept.find((o) => o.part === 'morning' && o.lean === 'calls')).toBe(a);
  });
});

describe('the spike book', () => {
  it('shows nothing until the all-names cell has enough graded spikes', () => {
    const book = buildSpikeBook(many(19, { signed: 1 }));
    expect(estimate(book, { isEtf: false }, 'all', 'morning', 'calls', 'close')).toBeNull();
    const enough = buildSpikeBook(many(20, { signed: 1 }));
    expect(estimate(enough, { isEtf: false }, 'all', 'morning', 'calls', 'close')).not.toBeNull();
  });

  it('shrinks toward 50% in proportion to the evidence', () => {
    const book = buildSpikeBook([...many(60, { signed: 1 }), ...many(30, { signed: -1 })]);
    const e = estimate(book, { isEtf: false }, 'all', 'morning', 'calls', 'm30')!;
    expect(e.n).toBe(90);
    expect(e.rate).toBeCloseTo((60 + 15) / (90 + 30), 9); // raw 66.7% → 62.5%
    expect(e.avgMove).toBeCloseTo(30 / 120, 9);
  });

  it('pulls a sector toward all names and a name toward its sector', () => {
    const book = buildSpikeBook([
      ...many(100, { sector: 'Energy', signed: -1 }), // elsewhere spikes fade…
      ...many(40, { sector: 'Tech', signed: 1 }), // …in Tech they follow through
      ...many(4, { sector: 'Tech', symbol: 'AAA', signed: -1 }).map((o, i) => ({ ...o, session: `2026-10-0${i + 1}` })),
    ]);
    const all = estimate(book, { isEtf: false }, 'all', 'morning', 'calls', 'close')!.rate;
    const tech = estimate(book, { sector: 'Tech', isEtf: false }, 'sector', 'morning', 'calls', 'close')!;
    const aaa = estimate(book, { symbol: 'AAA', sector: 'Tech', isEtf: false }, 'ticker', 'morning', 'calls', 'close')!;
    const unknown = estimate(book, { symbol: 'ZZZ', sector: 'Tech', isEtf: false }, 'ticker', 'morning', 'calls', 'close')!;
    expect(all).toBeLessThan(0.4);
    expect(tech.rate).toBeGreaterThan(all);
    expect(tech.n).toBe(44);
    expect(aaa.n).toBe(4);
    expect(aaa.rate).toBeLessThan(tech.rate); // its four fades pull it down a little…
    expect(aaa.rate).toBeGreaterThan(tech.rate - 0.1); // …but four spikes barely move it
    expect(unknown.rate).toBeCloseTo(tech.rate, 9); // no spikes of its own: its sector's
    expect(unknown.n).toBe(0);
  });

  it('weighs recent spikes more than old ones', () => {
    const book = buildSpikeBook([...many(30, { signed: 1, age: 0 }), ...many(30, { signed: -1, age: 240 })]);
    expect(estimate(book, { isEtf: false }, 'all', 'morning', 'calls', 'close')!.rate).toBeGreaterThan(0.55);
  });

  it('keeps ETFs in a pool of their own, scored on raw moves', () => {
    const etfs = many(25, { isEtf: true, sector: 'ETF', signed: 1 });
    const book = buildSpikeBook([...etfs, ...many(25, { signed: -1 })]);
    expect(estimate(book, { isEtf: true }, 'all', 'morning', 'calls', 'close')!.rate).toBeGreaterThan(0.6);
    expect(estimate(book, { isEtf: false }, 'all', 'morning', 'calls', 'close')!.rate).toBeLessThan(0.4);
    expect(spikeTable(book, { symbol: 'SPY', sector: 'ETF', isEtf: true }, 'all').graded).toBe(25);
  });

  it('lays out every time of day × lean, with counts at the level asked for', () => {
    const book = buildSpikeBook([...many(30, { signed: 1 }), ...many(22, { part: 'afternoon', lean: 'puts', signed: 1 })]);
    const t = spikeTable(book, { symbol: 'AAA', sector: 'Tech', isEtf: false }, 'all');
    expect(t.rows).toHaveLength(6);
    expect(t.graded).toBe(52);
    const row = t.rows.find((r) => r.part === 'afternoon' && r.lean === 'puts')!;
    expect(row.n).toBe(22);
    expect(row.cells.close.rate).toBeGreaterThan(0.5);
    expect(t.rows.find((r) => r.part === 'midday' && r.lean === 'calls')!.cells.close.rate).toBeNull();
  });
});

describe('followThroughNote', () => {
  const target = { symbol: 'AAA', sector: 'Tech', isEtf: false };
  const sessions = (n: number, over: Partial<SpikeObs> & { signed?: number }): SpikeObs[] =>
    many(n, over).map((o, i) => ({ ...o, session: `s${i}` }));

  it('quotes all names until the sector or the name has enough of its own', () => {
    const base = many(30, { sector: 'Energy', signed: 1 });
    expect(followThroughNote(buildSpikeBook(base), target, 20, 'calls')).toMatchObject({ level: 'all', n: 30, part: 'morning' });
    const withSector = [...base, ...many(20, { sector: 'Tech', signed: 1 })];
    expect(followThroughNote(buildSpikeBook(withSector), target, 20, 'calls')).toMatchObject({ level: 'sector', n: 20 });
    const withName = [...withSector, ...sessions(10, { symbol: 'AAA', sector: 'Tech', signed: 1 })];
    expect(followThroughNote(buildSpikeBook(withName), target, 20, 'calls')).toMatchObject({ level: 'ticker', n: 10 });
  });

  it('says nothing before enough spikes of that kind are graded', () => {
    expect(followThroughNote(buildSpikeBook(many(30, { signed: 1 })), target, 20, 'puts')).toBeNull();
    expect(followThroughNote(buildSpikeBook(many(30, { signed: 1 })), target, 200, 'calls')).toBeNull(); // midday: none graded
  });

  it('leaves out windows the session no longer has room for', () => {
    const book = buildSpikeBook(many(30, { part: 'afternoon', signed: 1 }));
    const early = followThroughNote(book, target, 300, 'calls')!;
    expect(early.m30).not.toBeNull();
    expect(early.close).not.toBeNull();
    expect(followThroughNote(book, target, 375, 'calls')!.m30).toBeNull(); // 3:45pm
    const afterBell = followThroughNote(book, target, 400, 'calls')!;
    expect(afterBell).toMatchObject({ m30: null, close: null });
    expect(afterBell.next).not.toBeNull();
  });
});
