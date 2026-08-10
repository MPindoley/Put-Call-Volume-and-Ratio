import { describe, expect, it } from 'vitest';
import {
  MAX_SYMBOLS_PER_REQUEST,
  chunk,
  fromYahooSymbol,
  parseSpark,
  toYahooSymbol,
} from './quotes';

describe('batching', () => {
  it('never exceeds the endpoint cap of 20 symbols', () => {
    // Verified against the live API: 21+ symbols returns
    // {"code":"Bad Request","description":"Number of symbols needs to be less than or equal to 20"}
    expect(MAX_SYMBOLS_PER_REQUEST).toBe(20);
    const universe = Array.from({ length: 552 }, (_, i) => `T${i}`);
    const batches = chunk(universe, MAX_SYMBOLS_PER_REQUEST);
    expect(batches.every((b) => b.length <= 20)).toBe(true);
    expect(batches.flat()).toHaveLength(552); // nothing dropped
    expect(batches).toHaveLength(28);
  });

  it('handles an empty universe without emitting a request', () => {
    expect(chunk([], 20)).toEqual([]);
  });
});

describe('share-class symbol mapping', () => {
  it('round-trips the dotted tickers in the universe', () => {
    // BRK.B and BF.B are in BY_SECTOR; Yahoo spells them with a hyphen.
    expect(toYahooSymbol('BRK.B')).toBe('BRK-B');
    expect(fromYahooSymbol('BRK-B')).toBe('BRK.B');
    expect(fromYahooSymbol(toYahooSymbol('BF.B'))).toBe('BF.B');
  });

  it('leaves ordinary tickers untouched', () => {
    expect(toYahooSymbol('AAPL')).toBe('AAPL');
    expect(fromYahooSymbol('AAPL')).toBe('AAPL');
  });
});

/** Shape captured from the live endpoint. */
function meta(over: Record<string, unknown> = {}) {
  return {
    symbol: 'SPY',
    regularMarketPrice: 772.935,
    chartPreviousClose: 768.56,
    regularMarketTime: 1786115758,
    ...over,
  };
}

describe('parseSpark', () => {
  it('extracts price, percent change and the venue trade time', () => {
    const [q] = parseSpark({ spark: { result: [{ symbol: 'SPY', response: [{ meta: meta() }] }] } });
    expect(q!.symbol).toBe('SPY');
    expect(q!.price).toBe(772.935);
    expect(q!.changePct).toBeCloseTo(((772.935 - 768.56) / 768.56) * 100, 10);
    // Seconds → ms, and it is the trade time, not the fetch time.
    expect(q!.at).toBe(1786115758_000);
  });

  it('maps hyphenated symbols back to the universe spelling', () => {
    const [q] = parseSpark({
      spark: { result: [{ symbol: 'BRK-B', response: [{ meta: meta({ symbol: 'BRK-B' }) }] }] },
    });
    expect(q!.symbol).toBe('BRK.B');
  });

  it('yields a null change rather than a fake 0 when prev close is missing', () => {
    const [q] = parseSpark({
      spark: { result: [{ symbol: 'SPY', response: [{ meta: meta({ chartPreviousClose: undefined }) }] }] },
    });
    expect(q!.changePct).toBeNull();
  });

  it('drops entries with no usable price instead of inventing one', () => {
    const quotes = parseSpark({
      spark: {
        result: [
          { symbol: 'AAA', response: [{ meta: meta({ symbol: 'AAA', regularMarketPrice: undefined }) }] },
          { symbol: 'BBB', response: [{ meta: meta({ symbol: 'BBB', regularMarketPrice: 0 }) }] },
          { symbol: 'CCC', response: [] },
          { symbol: 'DDD', response: [{ meta: meta({ symbol: 'DDD' }) }] },
        ],
      },
    });
    expect(quotes.map((q) => q.symbol)).toEqual(['DDD']);
  });

  it('tolerates an empty or malformed payload', () => {
    expect(parseSpark({})).toEqual([]);
    expect(parseSpark({ spark: {} })).toEqual([]);
    expect(parseSpark({ spark: { result: [] } })).toEqual([]);
  });
});
