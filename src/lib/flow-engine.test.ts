import { describe, expect, it } from 'vitest';
import { FlowEngine } from './flow-engine';
import type { OptionsChainAggregate } from './provider';

const MIN = 60_000;
// 10:00 ET on a weekday (14:00 UTC in October), well inside the session.
const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);

function snap(asOfMin: number, put: number, call: number, extra: Partial<OptionsChainAggregate> = {}): OptionsChainAggregate {
  return {
    symbol: 'TEST',
    putVolume: put,
    callVolume: call,
    putPremium: put * 50,
    callPremium: call * 50,
    underlyingPrice: 100,
    priceChangePct: 0,
    contractsSeen: 10,
    largestContractVolume: 10,
    iv30: null,
    iv30Change: null,
    asOf: T0 + asOfMin * MIN,
    ...extra,
  };
}

describe('FlowEngine.ingest — data-time flow windows', () => {
  it('reports a per-5-minute rate however far apart the snapshots are', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 10_000, 10_000), T0 + 15 * MIN);
    // 9 minutes later (data time): +900 puts, +450 calls → 500 / 250 per 5 minutes.
    const row = e.ingest(snap(9, 10_900, 10_450), T0 + 24 * MIN);
    expect(row.putVolume).toBe(500);
    expect(row.callVolume).toBe(250);
    expect(row.netFlow).toBe(-250);
    expect(row.flowWindowMs).toBe(9 * MIN);
    expect(row.putCallRatio).toBeCloseTo(2, 5);
  });

  it('stamps rows with the data time, not the fetch time', () => {
    const e = new FlowEngine();
    const row = e.ingest(snap(0, 100, 100), T0 + 16 * MIN);
    expect(row.dataAsOf).toBe(T0);
    expect(row.lastUpdated).toBe(T0 + 16 * MIN);
  });

  it('falls back to the fetch time when the provider gives no data time', () => {
    const e = new FlowEngine();
    const row = e.ingest(snap(0, 100, 100, { asOf: undefined }), T0 + 5 * MIN);
    expect(row.dataAsOf).toBe(T0 + 5 * MIN);
  });

  it('ignores a snapshot that is not newer than the last one (no false lull)', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 1_000, 1_000), T0);
    const fresh = e.ingest(snap(4, 1_400, 1_200), T0 + 4 * MIN);
    // Same snapshot served again by the CDN a few minutes later.
    const repeat = e.ingest(snap(4, 1_400, 1_200), T0 + 7 * MIN);
    expect(repeat.putVolume).toBe(fresh.putVolume);
    expect(repeat.callVolume).toBe(fresh.callVolume);
    expect(repeat.dataAsOf).toBe(fresh.dataAsOf);
    expect(repeat.lastUpdated).toBe(T0 + 7 * MIN);
  });

  it('never regresses to an older snapshot', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 1_000, 1_000), T0);
    e.ingest(snap(10, 2_000, 1_500), T0 + 10 * MIN);
    const older = e.ingest(snap(5, 1_500, 1_200), T0 + 12 * MIN);
    expect(older.sessionPutVolume).toBe(2_000);
    expect(older.dataAsOf).toBe(T0 + 10 * MIN);
  });

  it('starts a fresh window on a new session', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 50_000, 40_000), T0);
    e.ingest(snap(5, 51_000, 40_500), T0 + 5 * MIN);
    // Next morning: day volumes restart near zero.
    const next = e.ingest(snap(24 * 60, 200, 300), T0 + 24 * 60 * MIN);
    expect(next.putVolume).toBe(0);
    expect(next.flowWindowMs).toBeNull();
    expect(next.putCallRatio).toBeCloseTo(200 / 300, 5); // session ratio until a window exists
  });

  it('does not keep chain contracts in memory after ingesting', () => {
    const e = new FlowEngine();
    e.ingest(
      snap(0, 10, 10, {
        contracts: [{ type: 'call', strike: 100, expiration: T0 + 30 * 86_400_000, iv: 0.3, delta: 0.5, gamma: 0.01, openInterest: 10, volume: 1, mid: 1 }],
      }),
      T0,
    );
    const state = (e as unknown as { tickers: Map<string, { cumulative: OptionsChainAggregate }> }).tickers.get('TEST');
    expect(state?.cumulative.contracts).toBeUndefined();
  });
});
