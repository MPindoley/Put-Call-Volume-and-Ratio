import { describe, expect, it } from 'vitest';
import {
  calibrationStats,
  calibrationView,
  coverage,
  HORIZONS,
  standardizedMoves,
  type CalibrationStats,
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
