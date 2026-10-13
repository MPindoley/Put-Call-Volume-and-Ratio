/** Ticker-search ranking for the top-bar search box (pure, so it is unit-tested). */
import { UNIVERSE } from './universe';

const MAX_MATCHES = 8;

/**
 * Ranking: an exact symbol first, then symbols that start with the term, then
 * symbols that merely contain it. Within each group the most active names
 * (session option volume, when known) come first, so "NV" offers NVDA before
 * NVAX; ties fall back to shorter, then alphabetical.
 */
export function matchTickers(
  term: string,
  activity: (symbol: string) => number = () => 0,
): typeof UNIVERSE {
  const t = term.trim().toUpperCase();
  if (!t) return [];
  const rank = (s: string): number => (s === t ? 0 : s.startsWith(t) ? 1 : s.includes(t) ? 2 : 3);
  return UNIVERSE.filter((u) => rank(u.symbol) < 3)
    .sort(
      (a, b) =>
        rank(a.symbol) - rank(b.symbol) ||
        activity(b.symbol) - activity(a.symbol) ||
        a.symbol.length - b.symbol.length ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, MAX_MATCHES);
}
