import { describe, expect, it } from 'vitest';
import type { TickerFlow } from '@/types';
import { useFlowStore, selectVisibleRows } from '@/store/flowStore';
import { decodeSnapshot, encodeSnapshot, snapshotPayload } from './engine-snapshot';
import { FlowEngine } from './flow-engine';
import { formatMarketCap, marketCapOf, parseScreener } from './market-cap';
import type { OptionsChainAggregate } from './provider';

// The shape Nasdaq's screener returns (values are strings, caps without "$").
const SCREENER = {
  data: {
    rows: [
      { symbol: 'AAPL', lastsale: '$342.96', marketCap: '5005219972800.00' },
      { symbol: 'BRK/B', lastsale: '$526.35', marketCap: '1161291990126.00' },
      { symbol: 'F ', lastsale: '$12.05', marketCap: '47196760272.00' },
      { symbol: 'NOCAP', lastsale: '$5.00', marketCap: '' },
      { symbol: 'NOPRICE', lastsale: 'NA', marketCap: '1000000.00' },
      { symbol: 'BIG', lastsale: '$1,234.50', marketCap: '12345000000.00' },
    ],
  },
};

const row = (p: Partial<TickerFlow>): Pick<TickerFlow, 'sharesOutstanding' | 'livePrice' | 'underlyingPrice'> => ({
  sharesOutstanding: null,
  livePrice: null,
  underlyingPrice: 0,
  ...p,
});

describe('parseScreener', () => {
  it('derives shares outstanding from cap ÷ last sale, in the universe’s symbol style', () => {
    const shares = parseScreener(SCREENER);
    expect(shares.get('AAPL')).toBeCloseTo(5005219972800 / 342.96, 0);
    expect(shares.get('BRK.B')).toBeCloseTo(1161291990126 / 526.35, 0); // "BRK/B" → "BRK.B"
    expect(shares.get('F')).toBeCloseTo(47196760272 / 12.05, 0); // trimmed
    expect(shares.get('BIG')).toBeCloseTo(12345000000 / 1234.5, 3); // "$1,234.50"
  });

  it('skips rows without a positive cap and price instead of guessing', () => {
    const shares = parseScreener(SCREENER);
    expect(shares.has('NOCAP')).toBe(false);
    expect(shares.has('NOPRICE')).toBe(false);
    expect(parseScreener(null).size).toBe(0);
    expect(parseScreener({ data: {} }).size).toBe(0);
  });
});

describe('marketCapOf', () => {
  it('is shares × the live price, else the chain price', () => {
    expect(marketCapOf(row({ sharesOutstanding: 1e9, livePrice: 50, underlyingPrice: 49 }))).toBe(50e9);
    expect(marketCapOf(row({ sharesOutstanding: 1e9, underlyingPrice: 49 }))).toBe(49e9);
  });

  it('is null for funds (no shares) or without any price', () => {
    expect(marketCapOf(row({ livePrice: 50 }))).toBeNull();
    expect(marketCapOf(row({ sharesOutstanding: 1e9 }))).toBeNull();
    // A row saved before the field existed.
    expect(marketCapOf({ livePrice: 50, underlyingPrice: 50 } as TickerFlow)).toBeNull();
  });
});

describe('formatMarketCap', () => {
  it('uses T/B/M with three significant figures', () => {
    expect(formatMarketCap(5.0052e12)).toBe('$5.01T');
    expect(formatMarketCap(482.7e9)).toBe('$483B');
    expect(formatMarketCap(47.2e9)).toBe('$47.2B');
    expect(formatMarketCap(9.514e9)).toBe('$9.51B');
    expect(formatMarketCap(950e6)).toBe('$950M');
    expect(formatMarketCap(null)).toBe('—');
  });
});

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

describe('engine shares', () => {
  it('stamps shares onto existing and later rows, and reports only real changes', () => {
    const e = new FlowEngine();
    e.ingest(snap('AAPL', 300), Date.UTC(2026, 9, 14, 15, 15));
    const touched = e.setShares(
      new Map([
        ['AAPL', 14.6e9],
        ['MSFT', 7.4e9],
      ]),
    );
    expect(touched.map((f) => f.symbol)).toEqual(['AAPL']);
    expect(e.getFlow('AAPL')?.sharesOutstanding).toBe(14.6e9);
    // A row first seen afterwards gets its shares on arrival.
    expect(e.ingest(snap('MSFT', 500), Date.UTC(2026, 9, 14, 15, 16)).sharesOutstanding).toBe(7.4e9);
    // The next day's download wobbles by rounding only: nothing to push.
    expect(
      e.setShares(
        new Map([
          ['AAPL', 14.6e9 * 1.001],
          ['MSFT', 7.4e9],
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps saved shares across a restart until the screener answers', async () => {
    const e = new FlowEngine();
    e.mode = 'live';
    e.setShares(new Map([['AAPL', 14.6e9]]));
    e.ingest(snap('AAPL', 300), Date.UTC(2026, 9, 14, 15, 15));
    const saved = (await decodeSnapshot(await encodeSnapshot(snapshotPayload(e))))!;
    const next = new FlowEngine();
    next.restoreSnapshot(saved);
    expect(next.getFlow('AAPL')?.sharesOutstanding).toBe(14.6e9);
    expect(next.shares.get('AAPL')).toBe(14.6e9);
  });
});

describe('sorting by market cap', () => {
  it('orders companies by cap at the current price, funds last', () => {
    const base = new FlowEngine();
    base.setShares(
      new Map([
        ['AAA', 1e9],
        ['BBB', 3e9],
      ]),
    );
    const rows = Object.fromEntries(
      [base.ingest(snap('AAA', 100), 1), base.ingest(snap('BBB', 10), 2), base.ingest(snap('SPY', 600), 3)].map((r) => [
        r.symbol,
        r,
      ]),
    );
    useFlowStore.setState({
      rows,
      search: '',
      sectorFilter: 'All',
      flowFilter: 'all',
      pinned: [],
      sortKey: 'marketCap',
      sortDir: 'desc',
    });
    // AAA: 1e9 × 100 = $100B; BBB: 3e9 × 10 = $30B; SPY: a fund.
    expect(selectVisibleRows(useFlowStore.getState()).map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'SPY']);
  });
});
