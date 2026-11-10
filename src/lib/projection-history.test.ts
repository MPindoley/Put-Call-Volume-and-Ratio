import { describe, expect, it } from 'vitest';
import {
  addToTally,
  calibrationStats,
  calibrationView,
  conditionalRatio,
  conditionedMoves,
  conditionFactors,
  CONDITION_SHRINK_K,
  coverage,
  emptyTally,
  HORIZONS,
  ivState,
  ratioInForce,
  standardizedMoves,
  type CalibrationStats,
  type ConditionedMove,
  type ConditionState,
  type DayPoint,
} from './projection-history';

/** A seeded normal generator, so the statistical checks are deterministic. */
function rng(seed: number): () => number {
  let s = seed;
  const uniform = (): number => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (s + 0.5) / 2_147_483_648;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** Daily closes whose real volatility is `realized` while options price `implied`. */
function series(days: number, realized: number, implied: number, seed = 7): DayPoint[] {
  const z = rng(seed);
  const out: DayPoint[] = [];
  let close = 100;
  for (let i = 0; i < days; i++) {
    out.push({ session: i, close, iv30: implied * 100 });
    close *= Math.exp(realized * Math.sqrt(1 / 252) * z());
  }
  return out;
}

describe('calibration', () => {
  it('reads ~1 and textbook coverage when options price moves correctly', () => {
    // 21 sessions ≈ 30 calendar days, so the scaling matches.
    const s = calibrationStats(standardizedMoves(series(4_000, 0.3, 0.3 * Math.sqrt(30 / 365 / (21 / 252))), 'month'), 'month');
    expect(s.ratio!).toBeGreaterThan(0.9);
    expect(s.ratio!).toBeLessThan(1.1);
    expect(s.inside68!).toBeGreaterThan(0.6);
    expect(s.inside68!).toBeLessThan(0.76);
    expect(s.inside95!).toBeGreaterThan(0.9);
  });

  it('measures options overpricing moves as a ratio below 1', () => {
    const s = calibrationStats(standardizedMoves(series(3_000, 0.2, 0.3), 'week'), 'week');
    expect(s.ratio!).toBeLessThan(0.85);
    expect(s.inside68!).toBeGreaterThan(0.75);
  });

  it('counts non-overlapping periods, not overlapping windows', () => {
    const moves = standardizedMoves(series(105, 0.3, 0.3), 'month');
    expect(moves).toHaveLength(105 - HORIZONS.month.sessions);
    expect(calibrationStats(moves, 'month').periods).toBe(Math.floor(84 / 21));
  });

  it('skips sessions without an IV or an end close (gaps never bridge)', () => {
    const pts: DayPoint[] = [
      { session: 0, close: 100, iv30: 30 },
      { session: 1, close: 101, iv30: null },
      { session: 5, close: 103, iv30: 30 },
      { session: 7, close: 104, iv30: 30 },
    ];
    // Only session 0 → 5 is a complete 5-session window with an IV.
    expect(standardizedMoves(pts, 'week').map((m) => m.session)).toEqual([0]);
  });
});

const stats = (ratio: number | null, periods: number): CalibrationStats => ({
  horizon: 'month',
  n: periods * 21,
  periods,
  ratio,
  inside68: null,
  inside95: null,
  below: null,
  above: null,
});

describe('calibrationView (shrinkage)', () => {
  it('takes the market as priced with no history', () => {
    const v = calibrationView(stats(null, 0), stats(null, 0));
    expect(v.ratio).toBe(1);
    expect(v.usable).toBe(false);
  });

  it('leans on the sector until the stock has its own evidence', () => {
    const thin = calibrationView(stats(0.5, 1), stats(0.8, 40));
    const sectorOnly = 1 + (40 / 48) * (0.8 - 1);
    expect(thin.ratio).toBeCloseTo(sectorOnly + (1 / 9) * (0.5 - sectorOnly), 4);
    const rich = calibrationView(stats(0.5, 80), stats(0.8, 40));
    expect(rich.ratio).toBeLessThan(thin.ratio);
    expect(rich.tickerWeight).toBeCloseTo(80 / 88, 4);
  });
});

describe('coverage of logged projections', () => {
  it('counts outcomes inside each range and on which side they missed', () => {
    const base = { forward: 100, q025: 80, q16: 90, q84: 110, q975: 120, calRatio: null };
    const c = coverage([
      { ...base, outcome: 100 },
      { ...base, outcome: 95 },
      { ...base, outcome: 85 },
      { ...base, outcome: 125 },
      { ...base, outcome: null },
    ]);
    expect(c.n).toBe(4);
    expect(c.inside68).toBe(0.5);
    expect(c.inside95).toBe(0.75);
    expect(c.below68).toBe(0.25);
    expect(c.above68).toBe(0.25);
    expect(c.calibratedN).toBe(0);
  });

  it('checks the history-adjusted range on rows that carried one', () => {
    // Ratio 0.5 shrinks the 68% range to ≈[94.9, 104.9]: 96 is in, 92 is out.
    const row = { forward: 100, q025: 80, q16: 90, q84: 110, q975: 120, calRatio: 0.5 };
    const c = coverage([
      { ...row, outcome: 96 },
      { ...row, outcome: 92 },
    ]);
    expect(c.inside68).toBe(1);
    expect(c.calibratedInside68).toBe(0.5);
  });
});

describe('conditions: when moves run bigger or smaller than usual', () => {
  const state = (over: Partial<ConditionState> = {}): ConditionState => ({ vol: 'calm', iv: 'low', earnings: 'none', ...over });
  /** `n` weekly moves of size ±z starting on consecutive sessions from `from`. */
  const moves = (n: number, z: number, st: ConditionState, from = 0): ConditionedMove[] =>
    Array.from({ length: n }, (_, i) => ({ session: from + i, z: i % 2 ? z : -z, state: st }));

  it('calls a day’s IV high or low against the stock’s own earlier IVs, once there are enough', () => {
    const prior = Array.from({ length: 20 }, (_, i) => 20 + i); // 20…39, median 29.5
    expect(ivState(prior, 35)).toBe('high');
    expect(ivState(prior, 25)).toBe('low');
    expect(ivState(prior.slice(0, 19), 35)).toBeNull();
    expect(ivState(prior, null)).toBeNull();
  });

  it('tags each window with what was true at its start', () => {
    const pts: DayPoint[] = Array.from({ length: 40 }, (_, i) => ({ session: i, close: 100 + i, iv30: i < 30 ? 20 : 40 }));
    const vol = new Map<number, 'calm' | 'stressed'>(pts.map((p) => [p.session, p.session < 10 ? 'calm' : 'stressed']));
    const tagged = conditionedMoves(pts, 'week', vol, new Set([15]));
    const at = (session: number): ConditionState => tagged.find((m) => m.session === session)!.state;
    expect(at(5)).toEqual({ vol: 'calm', iv: null, earnings: 'none' }); // fewer than 20 earlier IVs
    expect(at(12)).toMatchObject({ vol: 'stressed', earnings: 'inside' }); // reports on session 15, inside (12, 17]
    expect(at(10).earnings).toBe('inside'); // session 15 is the window's last
    expect(at(9).earnings).toBe('none'); // …and just past this one's
    expect(at(15).earnings).toBe('none'); // the report day itself starts a window after it
    expect(at(25).iv).toBe('low'); // equal to its median: not above it
    expect(at(31).iv).toBe('high');
  });

  it('measures a factor as realized ÷ implied in the state over the pool’s usual', () => {
    const t = emptyTally();
    addToTally(t, moves(200, 1, state({ vol: 'calm' })));
    addToTally(t, moves(200, 1.5, state({ vol: 'stressed' }), 200));
    const f = conditionFactors(t, 'week');
    const usual = Math.sqrt((1 + 2.25) / 2);
    expect(f.vol[1].raw).toBeCloseTo(1.5 / usual, 3);
    expect(f.vol[0].raw).toBeCloseTo(1 / usual, 3);
    expect(f.vol[1].periods).toBe(40); // 200 distinct start sessions ÷ 5
    // 40 periods against a prior of 8: most of the way from 1 to the raw factor.
    expect(f.vol[1].factor).toBeCloseTo(1 + (40 / (40 + CONDITION_SHRINK_K)) * (1.5 / usual - 1), 3);
    // IV and earnings were the same state throughout: nothing to compare, so no factor.
    expect(f.iv[0]).toMatchObject({ raw: null, factor: 1 });
    expect(f.earnings[1]).toMatchObject({ raw: null, factor: 1, periods: 0 });
  });

  it('counts evidence in independent periods of the state, so many names on the same dates do not overstate it', () => {
    const t = emptyTally();
    for (let name = 0; name < 50; name++) {
      addToTally(t, moves(10, 1, state({ vol: 'calm' })));
      addToTally(t, moves(10, 2, state({ vol: 'stressed' }), 10));
    }
    const f = conditionFactors(t, 'week');
    expect(f.vol[1].periods).toBe(2); // 500 observations, but ten stressed sessions: two independent weeks
    expect(f.vol[1].factor).toBeLessThan(1 + 0.25 * (f.vol[1].raw! - 1)); // weight 2 / (2 + 8)
    expect(f.vol[1].factor).toBeGreaterThan(1);
  });

  it('pulls a sector’s factor toward all names’, and bounds it', () => {
    const all = emptyTally();
    addToTally(all, moves(400, 1, state()));
    addToTally(all, moves(400, 1.4, state({ earnings: 'inside' }), 400));
    const parent = conditionFactors(all, 'week');
    const thin = emptyTally();
    addToTally(thin, moves(5, 1, state()));
    addToTally(thin, moves(5, 0.2, state({ earnings: 'inside' }), 5)); // one quiet earnings week in this sector
    const sector = conditionFactors(thin, 'week', parent);
    expect(sector.earnings[1].raw).toBeLessThan(0.5);
    expect(sector.earnings[1].factor).toBeGreaterThan(1); // one period barely moves it off all names' 1.1+
    expect(sector.earnings[1].factor).toBeLessThan(parent.earnings[1].factor);
    const wild = emptyTally();
    addToTally(wild, moves(760, 0.1, state()));
    addToTally(wild, moves(40, 5, state({ vol: 'stressed' }), 760));
    expect(conditionFactors(wild, 'week').vol[1].factor).toBe(1.8);
    expect(conditionFactors(wild, 'week').vol[0].factor).toBe(0.6);
  });

  it('scales a stock’s ratio by the factors of the states it is in, skipping what is unknown', () => {
    const t = emptyTally();
    addToTally(t, moves(400, 1, state()));
    addToTally(t, moves(400, 1.5, state({ vol: 'stressed', iv: 'high' }), 400));
    const f = conditionFactors(t, 'week');
    const c = conditionalRatio(0.8, f, { vol: 'stressed', iv: null, earnings: 'none' });
    expect(c.applied.map((a) => a.condition)).toEqual(['vol', 'earnings']);
    expect(c.ratio).toBeCloseTo(0.8 * f.vol[1].factor * f.earnings[0].factor, 3);
    expect(c.ratio).toBeGreaterThan(0.8);
    expect(conditionalRatio(0.8, f, { vol: null, iv: null, earnings: null })).toEqual({ ratio: 0.8, applied: [] });
  });

  it('adjusts a range with the conditional ratio when there is one', () => {
    const stats = (ratio: number, periods: number): CalibrationStats => ({
      horizon: 'week',
      n: periods * 5,
      periods,
      ratio,
      inside68: null,
      inside95: null,
      below: null,
      above: null,
    });
    const v = calibrationView(stats(0.8, 40), stats(0.9, 400));
    expect(ratioInForce(v)).toBe(v.ratio);
    expect(ratioInForce({ ...v, conditional: { ratio: 1.02, applied: [] } })).toBe(1.02);
  });
});
