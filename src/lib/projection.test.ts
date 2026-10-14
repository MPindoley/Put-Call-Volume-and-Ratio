import { describe, expect, it } from 'vitest';
import type { RawContract } from '@/types';
import {
  calibratedPrice,
  computePositioning,
  computeProjection,
  normCdf,
  parityForward,
  pickExpiries,
  probAboveLevel,
  projectExpiry,
} from './projection';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 18, 0, 0);
/** Expiry dated so that T (to its ~20:00 UTC close) is exactly `days`. */
const expiryIn = (days: number): number => NOW + days * DAY - 20 * 3_600_000;

/** Black–Scholes (forward measure) prices for a synthetic chain with smile σ(k). */
function chain(opts: {
  forward: number;
  days: number;
  r?: number;
  vol: (k: number) => number;
  strikes?: number[];
  oi?: (type: 'call' | 'put', K: number) => number;
}): RawContract[] {
  const { forward: F, days, r = 0.04 } = opts;
  const T = days / 365;
  const disc = Math.exp(-r * T);
  const strikes = opts.strikes ?? Array.from({ length: 41 }, (_, i) => Math.round(F * (0.6 + i * 0.02) * 100) / 100);
  const out: RawContract[] = [];
  for (const K of strikes) {
    const k = Math.log(K / F);
    const s = opts.vol(k);
    const sd = s * Math.sqrt(T);
    const d1 = (-k + (s * s * T) / 2) / sd;
    const d2 = d1 - sd;
    const call = disc * (F * normCdf(d1) - K * normCdf(d2));
    const put = disc * (K * normCdf(-d2) - F * normCdf(-d1));
    for (const [type, price] of [
      ['call', call],
      ['put', put],
    ] as const) {
      out.push({
        type,
        strike: K,
        expiration: expiryIn(days),
        iv: s,
        delta: 0,
        gamma: 0,
        openInterest: opts.oi?.(type, K) ?? 0,
        volume: 0,
        mid: Math.max(price, 0.0001),
      });
    }
  }
  return out;
}

describe('normal CDF', () => {
  it('matches standard values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normCdf(-1.959964)).toBeCloseTo(0.025, 5);
  });
});

describe('put-call parity forward', () => {
  it('recovers a dividend-lowered forward from option prices', () => {
    const contracts = chain({ forward: 98, days: 60, vol: () => 0.3 });
    expect(parityForward(contracts, 100, 60 / 365, 0.04)).toBeCloseTo(98, 2);
  });

  it('falls back to spot without call/put pairs', () => {
    const calls = chain({ forward: 100, days: 30, vol: () => 0.3 }).filter((c) => c.type === 'call');
    expect(parityForward(calls, 100, 30 / 365, 0.04)).toBe(100);
  });
});

describe('projectExpiry', () => {
  it('reproduces the lognormal quantiles when the smile is flat', () => {
    const sigma = 0.3;
    const days = 30;
    const T = days / 365;
    const p = projectExpiry(chain({ forward: 100, days, vol: () => sigma }), expiryIn(days), 100, NOW);
    expect(p).not.toBeNull();
    const mu = -(sigma * sigma * T) / 2;
    const sd = sigma * Math.sqrt(T);
    const expected = [-1.959964, -0.994458, 0, 0.994458, 1.959964].map((z) => 100 * Math.exp(mu + z * sd));
    p!.quantiles.forEach((q, i) => expect(q).toBeCloseTo(expected[i]!, 0));
    expect(Math.abs(p!.quantiles[1]! - expected[1]!) / expected[1]!).toBeLessThan(0.003);
    expect(p!.atmIv).toBeCloseTo(30, 1);
    expect(p!.sigmaMove).toBeCloseTo(sd, 4);
    expect(p!.dte).toBeCloseTo(days, 5);
  });

  it('puts a fatter left tail on a put-skewed smile', () => {
    const days = 30;
    const flat = projectExpiry(chain({ forward: 100, days, vol: () => 0.3 }), expiryIn(days), 100, NOW)!;
    const skewed = projectExpiry(chain({ forward: 100, days, vol: (k) => 0.3 - 0.4 * k + 0.3 * k * k }), expiryIn(days), 100, NOW)!;
    expect(skewed.method).toBe('smile');
    const downside = (p: typeof flat): number => 100 - p.quantiles[0]!;
    const upside = (p: typeof flat): number => p.quantiles[4]! - 100;
    expect(downside(skewed)).toBeGreaterThan(downside(flat));
    expect(upside(skewed)).toBeLessThan(upside(flat));
    expect(downside(skewed)).toBeGreaterThan(upside(skewed));
  });

  it('agrees with the option prices it came from (digital ≈ call spread)', () => {
    const days = 45;
    const T = days / 365;
    const vol = (k: number): number => 0.35 - 0.3 * k + 0.2 * k * k;
    const contracts = chain({ forward: 100, days, vol, strikes: [94.5, 95.5, 105, 106, ...Array.from({ length: 31 }, (_, i) => 70 + i * 2)] });
    const p = projectExpiry(contracts, expiryIn(days), 100, NOW)!;
    const callAt = (K: number): number => contracts.find((c) => c.type === 'call' && c.strike === K)!.mid * Math.exp(0.04 * T);
    for (const K of [95, 105.5]) {
      // A tight call spread ≈ the undiscounted digital: P(S_T > K).
      const spread = (callAt(K - 0.5) - callAt(K + 0.5)) / 1;
      expect(probAboveLevel(p, K)).toBeCloseTo(spread, 1);
    }
  });

  it('extends the smile past the last quote without bending the tail', () => {
    // Same steep put skew, quoted only within ±6% vs across the whole chain:
    // the tails must agree, not dump mass at the edge of the quotes.
    const days = 30;
    const vol = (k: number): number => 0.25 - 0.5 * k;
    const narrow = Array.from({ length: 13 }, (_, i) => 94 + i);
    const full = projectExpiry(chain({ forward: 100, days, vol }), expiryIn(days), 100, NOW)!;
    const thin = projectExpiry(chain({ forward: 100, days, vol, strikes: narrow }), expiryIn(days), 100, NOW)!;
    expect(Math.abs(thin.quantiles[0]! / full.quantiles[0]! - 1)).toBeLessThan(0.01);
    expect(Math.abs(thin.quantiles[4]! / full.quantiles[4]! - 1)).toBeLessThan(0.01);
  });

  it('refuses expired or quote-less expiries', () => {
    expect(projectExpiry(chain({ forward: 100, days: 0.2, vol: () => 0.3 }), expiryIn(0.2), 100, NOW)).toBeNull();
    expect(projectExpiry([], expiryIn(30), 100, NOW)).toBeNull();
  });
});

describe('pickExpiries', () => {
  it('takes the nearest expiry plus the one closest to each horizon', () => {
    const exp = [2, 5, 9, 16, 23, 30, 37, 58, 86, 177, 365, 730].map(expiryIn);
    const picked = pickExpiries(exp, NOW).map((e) => Math.round((e - NOW) / DAY + 20 / 24));
    expect(picked).toEqual([2, 9, 30, 58, 86, 177]);
  });
});

describe('positioning', () => {
  it('finds the OI walls and where naive dealer gamma flips sign', () => {
    const contracts = chain({
      forward: 100,
      days: 20,
      vol: () => 0.3,
      oi: (type, K) => (type === 'call' && K === 110 ? 50_000 : type === 'put' && K === 90 ? 60_000 : type === 'call' ? 500 : 500),
    });
    const pos = computePositioning(contracts, 100, NOW);
    expect(pos.callWall).toBe(110);
    expect(pos.putWall).toBe(90);
    // Calls count +, puts −: the flip sits between the two walls.
    expect(pos.gammaFlip).not.toBeNull();
    expect(pos.gammaFlip!).toBeGreaterThan(90);
    expect(pos.gammaFlip!).toBeLessThan(110);
  });
});

describe('computeProjection', () => {
  it('builds a projection across expiries, and calibration rescales its width', () => {
    const contracts = [7, 30, 90].flatMap((days) => chain({ forward: 100, days, vol: () => 0.25 }));
    const proj = computeProjection('TEST', contracts, 100, NOW)!;
    expect(proj.expiries.map((e) => Math.round(e.dte))).toEqual([7, 30, 90]);
    // Wider ranges further out.
    const width = (i: number): number => proj.expiries[i]!.quantiles[3]! - proj.expiries[i]!.quantiles[1]!;
    expect(width(2)).toBeGreaterThan(width(1));
    expect(width(1)).toBeGreaterThan(width(0));
    // A 0.8 ratio pulls a level 20% closer in log terms.
    expect(Math.log(calibratedPrice(110, 100, 0.8) / 100)).toBeCloseTo(0.8 * Math.log(1.1), 10);
  });
});
