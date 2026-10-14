import { describe, expect, it } from 'vitest';
import { FlowEngine, REALTIME_FRESH_MS } from './flow-engine';
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
    const state = (e as unknown as { tickers: Map<string, { primary: { cumulative: OptionsChainAggregate } }> }).tickers.get(
      'TEST',
    );
    expect(state?.primary.cumulative.contracts).toBeUndefined();
  });
});

describe('FlowEngine.ingestRealtime — real-time overlay', () => {
  /** A real-time snapshot: data time = fetch time. */
  function rt(atMin: number, put: number, call: number, extra: Partial<OptionsChainAggregate> = {}): OptionsChainAggregate {
    return snap(atMin, put, call, { iv30: null, ...extra });
  }

  it('keeps the delayed figures until the real-time feed has measured a window of its own', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 10_000, 10_000), T0 + 15 * MIN);
    const delayed = e.ingest(snap(5, 10_500, 10_250), T0 + 20 * MIN);
    // First real-time snapshot: no window yet, so the row must not blank.
    const first = e.ingestRealtime(rt(20, 12_000, 11_000), T0 + 20 * MIN);
    expect(first.realtime).toBe(false);
    expect(first.putVolume).toBe(delayed.putVolume);
    expect(first.dataAsOf).toBe(delayed.dataAsOf);
  });

  it('takes over the flow figures and data time once measured, never deltas across feeds', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 10_000, 10_000, { iv30: 31 }), T0 + 15 * MIN);
    // Real-time counts differ from the delayed ones (and are 20 minutes newer):
    // a cross-feed delta would read +2,000 puts as trading.
    e.ingestRealtime(rt(20, 12_000, 11_000), T0 + 20 * MIN);
    const row = e.ingestRealtime(rt(22, 12_200, 11_100), T0 + 22 * MIN);
    expect(row.realtime).toBe(true);
    expect(row.putVolume).toBe(500); // +200 in 2 min → 500 per 5 min
    expect(row.callVolume).toBe(250);
    expect(row.sessionPutVolume).toBe(12_200);
    expect(row.dataAsOf).toBe(T0 + 22 * MIN);
    expect(row.flowWindowMs).toBe(2 * MIN);
    expect(row.iv30).toBe(31); // analytics stay on the feed of record
  });

  it('lets the delayed feed refresh analytics without overwriting live flow', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 10_000, 10_000, { iv30: 31 }), T0 + 15 * MIN);
    e.ingestRealtime(rt(20, 12_000, 11_000), T0 + 20 * MIN);
    e.ingestRealtime(rt(22, 12_200, 11_100), T0 + 22 * MIN);
    const row = e.ingest(snap(8, 11_000, 10_400, { iv30: 33 }), T0 + 23 * MIN);
    expect(row.iv30).toBe(33);
    expect(row.realtime).toBe(true);
    expect(row.putVolume).toBe(500);
    expect(row.dataAsOf).toBe(T0 + 22 * MIN);
  });

  it('hands flow back to the delayed feed when real-time goes quiet', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 10_000, 10_000), T0 + 15 * MIN);
    e.ingestRealtime(rt(20, 12_000, 11_000), T0 + 20 * MIN);
    e.ingestRealtime(rt(22, 12_200, 11_100), T0 + 22 * MIN);
    const later = T0 + 22 * MIN + REALTIME_FRESH_MS + MIN;
    const row = e.ingest(snap(10, 11_000, 10_500), later);
    expect(row.realtime).toBe(false);
    expect(row.dataAsOf).toBe(T0 + 10 * MIN);
    expect(row.putVolume).toBe(500); // its own 10-minute window: +1,000 puts
  });

  it('puts the real-time underlying price in the live-price fields only', () => {
    const e = new FlowEngine();
    e.ingest(snap(0, 100, 100, { underlyingPrice: 100 }), T0 + 15 * MIN);
    const row = e.ingestRealtime(rt(20, 200, 200, { underlyingPrice: 101.5, priceChangePct: 1.2 }), T0 + 20 * MIN, T0 + 20 * MIN - 2_000);
    expect(row.underlyingPrice).toBe(100);
    expect(row.livePrice).toBe(101.5);
    expect(row.livePriceChangePct).toBe(1.2);
    expect(row.livePriceAt).toBe(T0 + 20 * MIN - 2_000);
  });

  it('counts the names the real-time feed currently covers', () => {
    const e = new FlowEngine();
    e.realtimeFeed = {
      source: 'schwab',
      state: 'polling',
      liveTickers: 0,
      hotSetSize: 1,
      lastFetchAt: 0,
      callsLastMinute: 0,
      perMinute: 100,
      delayed: false,
      lastError: null,
      unsupported: 0,
      reconnectBy: null,
    };
    e.ingestRealtime(rt(20, 12_000, 11_000), T0 + 20 * MIN);
    expect(e.realtimeInfo(T0 + 21 * MIN)?.liveTickers).toBe(0);
    e.ingestRealtime(rt(22, 12_200, 11_100), T0 + 22 * MIN);
    expect(e.realtimeInfo(T0 + 23 * MIN)?.liveTickers).toBe(1);
    expect(e.realtimeInfo(T0 + 22 * MIN + REALTIME_FRESH_MS + 1)?.liveTickers).toBe(0);
  });
});
