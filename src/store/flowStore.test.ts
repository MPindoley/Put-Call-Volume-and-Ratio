import { describe, expect, it } from 'vitest';
import type { TickerFlow } from '@/types';
import { FlowEngine } from '@/lib/flow-engine';
import type { OptionsChainAggregate } from '@/lib/provider';
import { selectVisibleRows, useFlowStore, type SortKey } from './flowStore';

function snap(symbol: string, price: number): OptionsChainAggregate {
  return {
    symbol,
    putVolume: 100,
    callVolume: 200,
    putPremium: 1_000,
    callPremium: 2_000,
    underlyingPrice: price,
    priceChangePct: 0,
    contractsSeen: 10,
    largestContractVolume: 10,
    iv30: 30,
    iv30Change: 0,
    asOf: Date.UTC(2026, 9, 14, 15),
  };
}

/** Rows built by the engine, then given the fields a test needs. */
function rows(spec: Record<string, Partial<TickerFlow>>): Record<string, TickerFlow> {
  const e = new FlowEngine();
  return Object.fromEntries(
    Object.entries(spec).map(([symbol, extra], i) => [symbol, { ...e.ingest(snap(symbol, 100), i + 1), ...extra }]),
  );
}

function order(r: Record<string, TickerFlow>, sortKey: SortKey, sortDir: 'asc' | 'desc', pinned: string[] = []): string[] {
  useFlowStore.setState({ rows: r, search: '', sectorFilter: 'All', flowFilter: 'all', pinned, sortKey, sortDir });
  return selectVisibleRows(useFlowStore.getState()).map((x) => x.symbol);
}

describe('table sorting', () => {
  it('puts "—" market caps (funds) last in both directions', () => {
    const r = rows({
      BIG: { sharesOutstanding: 10e9 }, // $1T at $100
      SMALL: { sharesOutstanding: 1e7 }, // $1B
      SPY: { sharesOutstanding: null },
    });
    expect(order(r, 'marketCap', 'desc')).toEqual(['BIG', 'SMALL', 'SPY']);
    expect(order(r, 'marketCap', 'asc')).toEqual(['SMALL', 'BIG', 'SPY']);
  });

  it('puts rows without a live quote, skew or IV last in both directions', () => {
    const r = rows({
      UP: { livePriceChangePct: 2, iv30: 40, analytics: { rrSkew25: 3 } as TickerFlow['analytics'] },
      DOWN: { livePriceChangePct: -2, iv30: 20, analytics: { rrSkew25: -3 } as TickerFlow['analytics'] },
      NONE: { livePriceChangePct: null, iv30: null, analytics: null },
    });
    for (const key of ['livePrice', 'iv30', 'rrSkew'] as const) {
      expect(order(r, key, 'desc')).toEqual(['UP', 'DOWN', 'NONE']);
      expect(order(r, key, 'asc')).toEqual(['DOWN', 'UP', 'NONE']);
    }
  });

  it('treats a 5-minute rate that has not been measured yet as missing, not as 0', () => {
    const r = rows({
      CALLS: { flowWindowMs: 120_000, netFlow: 500 },
      PUTS: { flowWindowMs: 120_000, netFlow: -500 },
      UNMEASURED: { flowWindowMs: null, netFlow: 0 },
    });
    expect(order(r, 'netFlow', 'desc')).toEqual(['CALLS', 'PUTS', 'UNMEASURED']);
    expect(order(r, 'netFlow', 'asc')).toEqual(['PUTS', 'CALLS', 'UNMEASURED']);
  });

  it('still keeps pinned rows first, even when their value is missing', () => {
    const r = rows({ BIG: { sharesOutstanding: 10e9 }, SPY: { sharesOutstanding: null } });
    expect(order(r, 'marketCap', 'desc', ['SPY'])).toEqual(['SPY', 'BIG']);
  });
});
