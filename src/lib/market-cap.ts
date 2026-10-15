/**
 * Market capitalization for every listed stock in the universe.
 *
 * Source: Nasdaq's stock screener — one free download (~2 MB, ~7,000 US-listed
 * stocks across NYSE, Nasdaq and AMEX) with each company's market cap and last
 * sale. The app keeps SHARES OUTSTANDING (cap ÷ last sale) and shows
 *   market cap = shares outstanding × the current price
 * so the figure moves with the live quote instead of sitting at last night's
 * close. Refreshed at startup and each weekday morning; shares change rarely.
 *
 * ETFs and other funds are not in the list and have no market cap in this
 * sense (their size is assets under management), so they show "—"; so do the
 * few stocks the list omits or carries with a zero cap (~9 of ~1,340 measured).
 *
 * Kept apart from MarketCapConfig, which the sector analytics read to choose
 * their dispersion weighting: filling that table would silently change how
 * every sector's dispersion is computed.
 *
 * Like the quote sweep, this endpoint is undocumented and may change: a failed
 * or implausible download keeps the shares already known (never clears them).
 */
import type { TickerFlow } from '@/types';

const SCREENER = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true';
/** Fewer rows than this means a broken or partial download, not the market. */
export const MIN_SCREENER_ROWS = 1_000;

interface ScreenerRow {
  symbol?: string;
  lastsale?: string;
  marketCap?: string;
}

/** "$1,234.56" → 1234.56; blanks and junk → NaN. */
function money(s: string | undefined): number {
  return Number((s ?? '').replace(/[$,\s]/g, '') || NaN);
}

/**
 * Shares outstanding by symbol from the screener's JSON. Class shares come as
 * "BRK/B"; the universe (and CBOE) write "BRK.B". Rows without a positive cap
 * and price are skipped rather than guessed.
 */
export function parseScreener(json: unknown): Map<string, number> {
  const rows = (json as { data?: { rows?: ScreenerRow[] } })?.data?.rows ?? [];
  const out = new Map<string, number>();
  for (const r of rows) {
    const symbol = (r.symbol ?? '').trim().replace('/', '.').toUpperCase();
    const cap = money(r.marketCap);
    const price = money(r.lastsale);
    if (!symbol || !(cap > 0) || !(price > 0)) continue;
    out.set(symbol, cap / price);
  }
  return out;
}

/** Download shares outstanding; null on any failure or an implausibly short list. */
export async function fetchSharesOutstanding(timeoutMs = 30_000): Promise<Map<string, number> | null> {
  try {
    const res = await fetch(SCREENER, {
      headers: {
        // The API rejects requests without a browser-like agent.
        'User-Agent': 'Mozilla/5.0 (put-call-volume-and-ratio; market caps)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[market-cap] screener returned ${res.status}`);
      return null;
    }
    const shares = parseScreener(await res.json());
    if (shares.size < MIN_SCREENER_ROWS) {
      console.warn(`[market-cap] screener returned only ${shares.size} usable rows — keeping the shares already known`);
      return null;
    }
    return shares;
  } catch (err) {
    console.warn('[market-cap] screener download failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Market cap in dollars at the row's current price (live quote, else the chain's); null when unknown. */
export function marketCapOf(row: Pick<TickerFlow, 'sharesOutstanding' | 'livePrice' | 'underlyingPrice'>): number | null {
  const shares = row.sharesOutstanding ?? null;
  const price = row.livePrice ?? (row.underlyingPrice > 0 ? row.underlyingPrice : null);
  return shares !== null && shares > 0 && price !== null && price > 0 ? shares * price : null;
}

/** "$5.01T", "$483B", "$47.2B", "$9.51B", "$950M" — three significant figures. */
export function formatMarketCap(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n <= 0) return '—';
  const [value, unit] = n >= 1e12 ? [n / 1e12, 'T'] : n >= 1e9 ? [n / 1e9, 'B'] : [n / 1e6, 'M'];
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `$${value.toFixed(digits)}${unit}`;
}
