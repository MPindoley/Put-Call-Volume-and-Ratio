import { describe, expect, it } from 'vitest';
import {
  BaseRateSweep,
  buildBaseRates,
  buildEdgeBook,
  calibrate,
  establishedCounts,
  frozenSessions,
  MIN_BASE_SAMPLE,
  type Forecast,
  combineConviction,
  CONVICTION_CAP,
  estimateEdge,
  LEARNING_PARAMS,
  learningVersion,
  type DayObs,
  type Evidence,
  type LearningParams,
  type SignalKey,
} from './learning';

// No recency decay unless a test is about recency — keeps the arithmetic exact.
const FLAT: LearningParams = { ...LEARNING_PARAMS, halfLifeSessions: Infinity }; // 0.5^(x/∞) = 1 exactly

const KEY: SignalKey = {
  signalType: 'skew_z',
  direction: 'bullish',
  regime: 'pos|pos',
  sector: 'Technology',
  symbol: 'AAPL',
};

function ev(over: Partial<Evidence> = {}): Evidence {
  return { ...KEY, firedIdx: 0, knownIdx: 10, hit: true, base: 0.5, ...over };
}

describe('edge book — honesty properties', () => {
  it('knows nothing from nothing: an empty book reads exactly zero edge', () => {
    const est = estimateEdge(buildEdgeBook([], 100, 'v', FLAT), KEY);
    expect(est.edge).toBe(0);
    expect(est.n).toBe(0);
    expect(est.path.every((p) => p.evidence === 0)).toBe(true);
  });

  it('never uses an outcome that was not yet knowable (point-in-time)', () => {
    const rows = [ev({ knownIdx: 10 }), ev({ knownIdx: 11 })];
    expect(buildEdgeBook(rows, 10, 'v', FLAT).rowsUsed).toBe(1);
    expect(buildEdgeBook(rows, 9, 'v', FLAT).rowsUsed).toBe(0);
  });

  it('shrinks toward no-edge in proportion to the evidence', () => {
    // 40 hits / 40 at base 0.5 → raw excess +0.5, signal prior k=40 → 20/(40+40) = 0.25.
    const book = buildEdgeBook(Array.from({ length: 40 }, () => ev()), 100, 'v', FLAT);
    const sig = estimateEdge(book, KEY).path[0]!;
    expect(sig.raw).toBeCloseTo(0.5, 12);
    expect(sig.edge).toBeCloseTo(0.25, 12);
    expect(sig.evidence).toBeCloseTo(0.5, 12);
  });

  it('measures edge against the base rate, not against 50%', () => {
    // A stock that rises 70% of days: a bullish signal hitting 70% has NO edge.
    const rows = Array.from({ length: 100 }, (_, i) => ev({ hit: i < 70, base: 0.7 }));
    expect(estimateEdge(buildEdgeBook(rows, 100, 'v', FLAT), KEY).edge).toBeCloseTo(0, 12);
  });

  it('a thinly-evidenced ticker inherits nearly all of its estimate from above', () => {
    // 200 sector peers at a modest +0.1 excess; this ticker has 3 lucky perfect hits.
    const peers = Array.from({ length: 200 }, (_, i) => ev({ symbol: `P${i}`, hit: i % 10 < 6 }));
    const lucky = Array.from({ length: 3 }, () => ev({ symbol: 'AAPL', hit: true }));
    const est = estimateEdge(buildEdgeBook([...peers, ...lucky], 100, 'v', FLAT), KEY);
    const sector = est.path[2]!;
    const ticker = est.path[3]!;
    expect(ticker.raw).toBeCloseTo(0.5, 12); // its own record looks brilliant…
    expect(ticker.evidence).toBeLessThan(0.05); // …but carries < 5% weight
    expect(Math.abs(ticker.edge - sector.edge)).toBeLessThan(0.02);
  });

  it('inherits the parent estimate when a level has no data at all', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ev({ symbol: `P${i}` }));
    const est = estimateEdge(buildEdgeBook(rows, 100, 'v', FLAT), { ...KEY, symbol: 'NEWCO' });
    expect(est.path[3]!.n).toBe(0);
    expect(est.path[3]!.edge).toBe(est.path[2]!.edge);
  });

  it('lets old evidence fade so a signal that stops working loses its edge', () => {
    // Old era: wins. Recent era: losses. With decay, the recent era dominates.
    const old = Array.from({ length: 100 }, () => ev({ firedIdx: 0, knownIdx: 10, hit: true }));
    const recent = Array.from({ length: 100 }, () => ev({ firedIdx: 480, knownIdx: 490, hit: false }));
    const decayed = estimateEdge(buildEdgeBook([...old, ...recent], 500, 'v', LEARNING_PARAMS), KEY);
    const flat = estimateEdge(buildEdgeBook([...old, ...recent], 500, 'v', FLAT), KEY);
    expect(flat.edge).toBeCloseTo(0, 12); // equal weight: wins and losses cancel
    expect(decayed.edge).toBeLessThan(-0.1); // recency: it has stopped working
  });

  it('skips rows without a base rate rather than guessing one', () => {
    const book = buildEdgeBook([ev(), ev({ base: null })], 100, 'v', FLAT);
    expect(book.rowsUsed).toBe(1);
    expect(book.rowsUnbased).toBe(1);
  });

  it('keeps different signals, directions and regimes in separate nodes', () => {
    const rows = Array.from({ length: 60 }, () => ev({ hit: true }));
    const book = buildEdgeBook(rows, 100, 'v', FLAT);
    expect(estimateEdge(book, { ...KEY, direction: 'bearish' }).edge).toBe(0);
    expect(estimateEdge(book, { ...KEY, signalType: 'divergence' }).edge).toBe(0);
    // Same signal, other regime: inherits the signal-level edge but no regime evidence.
    const other = estimateEdge(book, { ...KEY, regime: 'neg|neg' });
    expect(other.path[1]!.n).toBe(0);
    expect(other.edge).toBeCloseTo(estimateEdge(book, KEY).path[0]!.edge, 12);
  });
});

describe('combineConviction', () => {
  const winners = Array.from({ length: 200 }, (_, i) => ev({ symbol: `P${i}`, hit: i % 10 < 7 }));
  const book = buildEdgeBook(winners, 100, 'v', FLAT);

  it('is thin with no active signals', () => {
    const c = combineConviction(book, []);
    expect(c.thin).toBe(true);
    expect(c.direction).toBeNull();
  });

  it('signs a learned edge by the signal direction', () => {
    const c = combineConviction(book, [KEY]);
    expect(c.score).toBeGreaterThan(0);
    expect(c.direction).toBe('bullish');
  });

  it('nets opposing signals', () => {
    // A bearish skew_z has no evidence here → contributes 0; equal & opposite would cancel.
    const twin = buildEdgeBook(
      [...winners, ...winners.map((w) => ({ ...w, direction: 'bearish' as const }))],
      100,
      'v',
      FLAT,
    );
    const c = combineConviction(twin, [KEY, { ...KEY, direction: 'bearish' }]);
    expect(c.score).toBeCloseTo(0, 12);
    expect(c.thin).toBe(true);
  });

  it('divides co-firing signals by √m rather than summing them', () => {
    // A modest book, so the combination stays well under the cap.
    const modest = buildEdgeBook(
      Array.from({ length: 200 }, (_, i) => ev({ symbol: `P${i}`, hit: i % 20 < 11 })),
      100,
      'v',
      FLAT,
    );
    const one = combineConviction(modest, [KEY]).score;
    const two = combineConviction(modest, [KEY, KEY]).score;
    expect(two).toBeLessThan(CONVICTION_CAP);
    expect(two).toBeCloseTo((2 * one) / Math.SQRT2, 12);
  });

  it('never claims more than the cap', () => {
    const perfect = buildEdgeBook(Array.from({ length: 10_000 }, () => ev()), 100, 'v', FLAT);
    const c = combineConviction(perfect, Array.from({ length: 6 }, () => KEY));
    expect(c.score).toBe(CONVICTION_CAP);
  });

  it('reads 0 for a signal type with no history — no invented confidence', () => {
    const c = combineConviction(buildEdgeBook([], 100, 'v', FLAT), [KEY]);
    expect(c.score).toBe(0);
    expect(c.thin).toBe(true);
  });
});

describe('buildBaseRates (point-in-time, matrix rules)', () => {
  const day = (over: Partial<DayObs>): DayObs => ({
    type: 'skew_z',
    symbol: 'AAPL',
    cell: 'pos|pos|na',
    knownIdx: 10,
    ret: 0.01,
    ...over,
  });
  const cohortOf = (s: string): string | null => (s === 'ETFX' ? null : 'XLK');

  it("uses the ticker's own days when it has enough", () => {
    const days = [...Array.from({ length: 30 }, () => day({ ret: 0.01 })), ...Array.from({ length: 10 }, () => day({ ret: -0.01 }))];
    const base = buildBaseRates(days, 100, 20, cohortOf);
    expect(base('skew_z', 'AAPL', 'pos|pos|na', 'bullish')).toBeCloseTo(0.75, 12);
    expect(base('skew_z', 'AAPL', 'pos|pos|na', 'bearish')).toBeCloseTo(0.25, 12);
  });

  it('falls back to the cohort below the ticker-day minimum', () => {
    const days = [
      day({ symbol: 'NEW', ret: 0.01 }), // 1 own day — too few
      ...Array.from({ length: 40 }, (_, i) => day({ symbol: 'MSFT', ret: i < 10 ? 0.01 : -0.01 })),
    ];
    const base = buildBaseRates(days, 100, 20, cohortOf);
    expect(base('skew_z', 'NEW', 'pos|pos|na', 'bullish')).toBeCloseTo(11 / 41, 12);
  });

  it('ignores days whose outcome was not yet knowable', () => {
    const days = Array.from({ length: 30 }, (_, i) => day({ knownIdx: i < 25 ? 10 : 200, ret: i < 25 ? 0.01 : -0.01 }));
    const base = buildBaseRates(days, 100, 20, cohortOf, 1); // sample floor off: testing PIT only
    expect(base('skew_z', 'AAPL', 'pos|pos|na', 'bullish')).toBe(1);
  });

  it('returns null rather than guessing when nothing is known', () => {
    expect(buildBaseRates([], 100, 20, cohortOf)('skew_z', 'ETFX', 'pos|pos|na', 'bullish')).toBeNull();
  });

  it('counts a zero return as neither up nor down (matrix rule)', () => {
    const days = Array.from({ length: 20 }, (_, i) => day({ ret: i < 10 ? 0 : 0.01 }));
    expect(buildBaseRates(days, 100, 20, cohortOf, 1)('skew_z', 'AAPL', 'pos|pos|na', 'bullish')).toBeCloseTo(0.5, 12);
  });

  it(`refuses a base rate resting on fewer than ${MIN_BASE_SAMPLE} observations`, () => {
    // Early on, two knowable days would read 0% or 100% — noise, not a base rate.
    const two = [day({ symbol: 'MSFT', ret: -0.01 }), day({ symbol: 'MSFT', ret: -0.02 })];
    expect(buildBaseRates(two, 100, 20, cohortOf)('skew_z', 'NEW', 'pos|pos|na', 'bullish')).toBeNull();
    const enough = Array.from({ length: MIN_BASE_SAMPLE }, (_, i) => day({ symbol: 'MSFT', ret: i % 2 ? 0.01 : -0.01 }));
    expect(buildBaseRates(enough, 100, 20, cohortOf)('skew_z', 'NEW', 'pos|pos|na', 'bullish')).toBeCloseTo(0.5, 12);
  });
});

describe('learningVersion', () => {
  it('changes when any parameter or upstream definition changes', () => {
    const v = learningVersion(LEARNING_PARAMS, 't', 'r');
    expect(learningVersion(LEARNING_PARAMS, 't', 'r')).toBe(v);
    expect(learningVersion({ ...LEARNING_PARAMS, halfLifeSessions: 60 }, 't', 'r')).not.toBe(v);
    expect(learningVersion({ ...LEARNING_PARAMS, horizon: 20 }, 't', 'r')).not.toBe(v);
    expect(learningVersion(LEARNING_PARAMS, 't2', 'r')).not.toBe(v);
    expect(learningVersion(LEARNING_PARAMS, 't', 'r2')).not.toBe(v);
  });
});

describe('parseConvictions (stored book → engine)', () => {
  it('round-trips serializeConvictions', async () => {
    const { parseConvictions, serializeConvictions } = await import('./learning-data');
    const json = serializeConvictions(
      new Map([
        ['AAPL', { score: 0.042, direction: 'bullish', thin: false, parts: [{ signalType: 'skew_z', direction: 'bullish', edge: 0.042, se: 0.05, n: 40, signalEvidence: 0.5 }] }],
      ]),
    );
    const m = parseConvictions(json, '2026-10-12');
    expect(m.get('AAPL')).toEqual({
      score: 0.042,
      direction: 'bullish',
      asOf: '2026-10-12',
      parts: [{ signalType: 'skew_z', direction: 'bullish', edge: 0.042, n: 40 }],
    });
  });

  it('keeps a below-floor net but marks it directionless (UI shows —)', async () => {
    const { parseConvictions } = await import('./learning-data');
    const m = parseConvictions({ MSFT: { s: 0.004, p: [] } }, '2026-10-12');
    expect(m.get('MSFT')?.direction).toBeNull();
    expect(m.get('MSFT')?.score).toBe(0.004);
  });

  it('skips malformed entries instead of guessing', async () => {
    const { parseConvictions } = await import('./learning-data');
    const m = parseConvictions(
      { A: { s: 'x', p: [] }, B: { s: 0.05 }, C: { s: 0.05, p: [['skew_z', 'sideways', 0.1, 3], ['skew_z', 'bearish', 0.1, 3]] } },
      '2026-10-12',
    );
    expect([...m.keys()]).toEqual(['C']);
    expect(m.get('C')!.parts).toHaveLength(1); // the 'sideways' part is dropped
    expect(parseConvictions(null, 'x').size).toBe(0);
  });
});

describe('BaseRateSweep', () => {
  const cohortOf = (): string => 'XLK';
  const days: DayObs[] = Array.from({ length: 300 }, (_, i) => ({
    type: i % 2 ? 'skew_z' : 'pc_extreme',
    symbol: ['AAPL', 'MSFT', 'NVDA'][i % 3]!,
    cell: i % 5 ? 'pos|pos|na' : 'neg|pos|na',
    knownIdx: (i * 7) % 97,
    ret: ((i * 13) % 7) - 3, // mix of +, −, 0
  }));

  it('matches the one-shot computation at every point in time', () => {
    const sweep = new BaseRateSweep(days, 20, cohortOf);
    for (const a of [0, 5, 30, 60, 96, 200]) {
      sweep.advanceTo(a);
      const once = buildBaseRates(days, a, 20, cohortOf);
      for (const sym of ['AAPL', 'MSFT', 'NVDA', 'NEW'])
        for (const type of ['skew_z', 'pc_extreme'])
          for (const cell of ['pos|pos|na', 'neg|pos|na'])
            for (const dir of ['bullish', 'bearish'] as const)
              expect(sweep.lookup(type, sym, cell, dir)).toBe(once(type, sym, cell, dir));
    }
  });

  it('refuses to move backward in time', () => {
    const sweep = new BaseRateSweep(days, 20, cohortOf).advanceTo(50);
    expect(() => sweep.advanceTo(49)).toThrow(/backward/);
  });
});

describe('frozenSessions', () => {
  const S = Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);

  it('flags a run of ≥5 identical closes (a ghost price), not shorter ties', () => {
    const closes = new Map(S.map((d, i) => [d, i < 3 ? 100 + i : i < 9 ? 198.1 : 200 + i]));
    const f = frozenSessions(closes, S);
    expect([...f].sort()).toEqual(S.slice(3, 9)); // the six 198.1 sessions
    const ties = new Map(S.map((d, i) => [d, i < 4 ? 50 : 50 + i])); // 4 equal, then moves
    expect(frozenSessions(ties, S).size).toBe(0);
  });

  it('a missing close breaks a run rather than bridging it', () => {
    const closes = new Map(S.filter((_, i) => i !== 3).map((d) => [d, 100]));
    // runs: S0..S2 (3) | gap | S4..S11 (8) → only the second is frozen
    expect([...frozenSessions(closes, S)].sort()).toEqual(S.slice(4));
  });
});

describe('calibrate (self-grading)', () => {
  const S = Array.from({ length: 60 }, (_, i) => (i < 30 ? `2026-08-${String(i + 1).padStart(2, '0')}` : `2026-09-${String(i - 29).padStart(2, '0')}`));
  const f = (q: number, base: number, hit: boolean, asOfIdx = 0): Forecast => ({ asOfIdx, symbol: 'X', direction: 'bullish', q, base, hit });

  it('reports a well-calibrated learner as calibrated, with positive skill', () => {
    // Claims +10 over a 50% base, and hits 60% → exactly as claimed.
    const fs = Array.from({ length: 1000 }, (_, i) => f(0.1, 0.5, i % 10 < 6));
    const c = calibrate(fs, S);
    expect(c.realized).toBeCloseTo(0.1, 12);
    expect(c.predicted).toBeCloseTo(0.1, 12);
    expect(c.skill!).toBeGreaterThan(0);
  });

  it('exposes overconfidence: claims edge, delivers none → negative skill', () => {
    const fs = Array.from({ length: 1000 }, (_, i) => f(0.1, 0.5, i % 2 === 0));
    const c = calibrate(fs, S);
    expect(c.realized).toBeCloseTo(0, 12);
    expect(c.skill!).toBeLessThan(0); // worse than just knowing the base rate
  });

  it('bins by claimed strength and tracks the trend by month', () => {
    const fs = [
      ...Array.from({ length: 10 }, () => f(0.02, 0.5, true, 0)),
      ...Array.from({ length: 10 }, () => f(0.12, 0.5, false, 40)),
    ];
    const c = calibrate(fs, S);
    expect(c.bins.map((b) => b.label)).toEqual(['1–3 pts', '10+ pts']);
    expect(c.byMonth.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(c.byMonth[0]!.realized).toBeCloseTo(0.5, 12);
    expect(c.byMonth[1]!.realized).toBeCloseTo(-0.5, 12);
  });

  it('is empty, not invented, with no forecasts', () => {
    const c = calibrate([], S);
    expect(c.n).toBe(0);
    expect(c.skill).toBeNull();
    expect(c.bins).toEqual([]);
  });
});

describe('establishedCounts', () => {
  it('counts a node as established once its own data carries ≥ half the weight', () => {
    // 40 obs vs signal k=40 → evidence exactly 0.5 (established); ticker k=80 → 0.33 (not).
    const book = buildEdgeBook(Array.from({ length: 40 }, () => ev()), 100, 'v', FLAT);
    const c = establishedCounts(book);
    expect(c.signal).toEqual({ established: 1, total: 1 });
    expect(c.ticker).toEqual({ established: 0, total: 1 });
  });
});
