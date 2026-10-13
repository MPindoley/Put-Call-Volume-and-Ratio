import { describe, expect, it } from 'vitest';
import { matchTickers } from './ticker-search';

describe('matchTickers', () => {
  it('returns nothing for an empty term', () => {
    expect(matchTickers('  ')).toEqual([]);
  });

  it('puts an exact symbol first, case-insensitively', () => {
    expect(matchTickers('amd')[0]?.symbol).toBe('AMD');
  });

  it('ranks prefix matches above names that merely contain the term', () => {
    const syms = matchTickers('NV').map((m) => m.symbol);
    const firstContains = syms.findIndex((s) => !s.startsWith('NV'));
    const lastPrefix = syms.map((s) => s.startsWith('NV')).lastIndexOf(true);
    expect(firstContains === -1 || lastPrefix < firstContains).toBe(true);
  });

  it('orders prefix matches by activity when it is known', () => {
    const volume: Record<string, number> = { NVDA: 1_000_000, NVO: 10 };
    expect(matchTickers('NV', (s) => volume[s] ?? 0)[0]?.symbol).toBe('NVDA');
  });

  it('caps the list', () => {
    expect(matchTickers('A').length).toBeLessThanOrEqual(8);
  });
});
