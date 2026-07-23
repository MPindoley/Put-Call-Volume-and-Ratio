import { describe, expect, it } from 'vitest';
import type { RawContract } from '@/types';
import { buildExpiryQuotes, computeEventMoveForChain } from './event-analytics';

const expA = Date.UTC(2026, 7, 14); // Fri Aug 14 2026
const expB = Date.UTC(2026, 8, 4); // Fri Sep 4 2026
const now = new Date('2026-08-03T15:00:00Z'); // Mon

function c(over: Partial<RawContract>): RawContract {
  return {
    type: 'call',
    strike: 100,
    expiration: expA,
    iv: 0.6,
    delta: 0.5,
    gamma: 0.01,
    openInterest: 1000,
    volume: 10,
    mid: 5,
    bid: 4.8,
    ask: 5.2,
    ...over,
  };
}

const chain: RawContract[] = [
  c({ type: 'call', expiration: expA, iv: 0.6, openInterest: 3000 }),
  c({ type: 'put', expiration: expA, iv: 0.6, openInterest: 3000 }),
  c({ type: 'call', expiration: expB, iv: 0.45, openInterest: 2000, mid: 6, bid: 5.8, ask: 6.2 }),
  c({ type: 'put', expiration: expB, iv: 0.45, openInterest: 2000, mid: 6, bid: 5.8, ask: 6.2 }),
  // far OTM noise so ATM selection must pick strike 100
  c({ type: 'call', strike: 130, expiration: expA, iv: 0.7, openInterest: 50 }),
];

describe('buildExpiryQuotes', () => {
  it('extracts ATM IV, OI and quote width per expiry', () => {
    const quotes = buildExpiryQuotes(chain, 100, now.getTime());
    expect(quotes).toHaveLength(2);
    const a = quotes.find((q) => q.expiry === '2026-08-14')!;
    expect(a.iv).toBeCloseTo(0.6, 10);
    expect(a.atmOpenInterest).toBe(6000);
    expect(a.quoteWidthFrac).toBeCloseTo(0.4 / 5, 10); // (5.2−4.8)/5
    expect(a.tradingDays).toBeGreaterThan(0);
  });

  it('reports Infinity width when the ATM strike has no two-sided quotes', () => {
    const noQuotes = chain.map((x) =>
      x.strike === 100 && x.expiration === expA ? { ...x, bid: undefined, ask: undefined } : x,
    );
    const a = buildExpiryQuotes(noQuotes, 100, now.getTime()).find((q) => q.expiry === '2026-08-14')!;
    expect(a.quoteWidthFrac).toBe(Infinity);
  });
});

describe('computeEventMoveForChain', () => {
  it('produces a positive event move from a near-expiry IV bulge (bracket B)', () => {
    const event = new Date('2026-08-10T12:00:00Z'); // both expiries span it
    const res = computeEventMoveForChain(chain, 100, event, now);
    expect(res).not.toBeNull();
    expect(res!.method).toBe('two-post-event');
    expect(res!.impliedMove).toBeGreaterThan(0);
  });

  it('refuses (null) when the ATM quotes are too wide for the floor', () => {
    const wide = chain.map((x) => ({ ...x, bid: 1, ask: 9 })); // width 8/5 ≫ 25%
    const reasons: string[] = [];
    const res = computeEventMoveForChain(wide, 100, new Date('2026-08-10T12:00:00Z'), now, undefined, (r) =>
      reasons.push(r),
    );
    expect(res).toBeNull();
    expect(reasons[0]).toMatch(/liquidity floor/);
  });
});
