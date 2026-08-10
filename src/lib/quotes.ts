/**
 * Live underlying quotes — the one genuinely real-time, genuinely free feed in
 * this stack.
 *
 * Why this exists separately from the options provider: the CBOE chain endpoint
 * is 15-minute delayed by OPRA licensing AND costs 0.4–6 MB per symbol, so a
 * full 552-name rotation moves ~400 MB and takes ~9 minutes. Prices therefore
 * crawled. Equity last-trade prices are not OPRA-restricted, and Yahoo's spark
 * endpoint returns them ~20 seconds old at ~1 KB/symbol, 20 symbols per
 * request — a full sweep of the universe is ~28 requests and ~580 KB, roughly
 * 1.4% of one chain rotation. That buys a live price on every row essentially
 * for free while the heavy analytics stay on their slow, delayed cadence.
 *
 * Caveat, deliberately documented: this endpoint is undocumented and not
 * covered by a Yahoo API agreement. It can change or rate-limit without notice,
 * so every failure degrades to "no live quote" (the chain-derived price and its
 * age remain visible) rather than to a wrong or invented number. Set
 * QUOTE_SOURCE=off to disable the sweep entirely.
 */

/** Yahoo's spark endpoint rejects >20 symbols per call ("Bad Request"). */
export const MAX_SYMBOLS_PER_REQUEST = 20;

const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';

export interface LiveQuote {
  symbol: string;
  price: number;
  /** Percent change vs the previous close, or null when that is unavailable. */
  changePct: number | null;
  /** Venue trade time in ms — when the price happened, not when we fetched it. */
  at: number;
}

interface SparkMeta {
  symbol?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
}

interface SparkResponse {
  spark?: { result?: { symbol?: string; response?: { meta?: SparkMeta }[] }[] };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Yahoo uses '-' where OCC/CBOE use '.' for share classes (BRK.B → BRK-B). */
export function toYahooSymbol(symbol: string): string {
  return symbol.replace(/\./g, '-');
}

export function fromYahooSymbol(symbol: string): string {
  return symbol.replace(/-/g, '.');
}

/** Parse a spark payload into quotes, skipping any entry missing a usable price. */
export function parseSpark(body: SparkResponse): LiveQuote[] {
  const out: LiveQuote[] = [];
  for (const entry of body.spark?.result ?? []) {
    const meta = entry.response?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const raw = meta?.symbol ?? entry.symbol;
    if (!raw || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    const prev = meta?.chartPreviousClose;
    const changePct =
      typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : null;
    out.push({
      symbol: fromYahooSymbol(raw),
      price,
      changePct,
      at: typeof meta?.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : Date.now(),
    });
  }
  return out;
}

export class QuoteClient {
  readonly name = 'yahoo-spark';
  /** Batches that failed on the most recent sweep (surfaced for the status bar). */
  lastErrors = 0;

  constructor(private readonly pauseMs = 120) {}

  /**
   * Fetch live quotes for every symbol, 20 at a time. A failed batch is skipped,
   * never retried inline and never faked — those symbols simply keep their prior
   * price and grow visibly stale.
   */
  async fetchAll(symbols: string[]): Promise<LiveQuote[]> {
    const batches = chunk(symbols, MAX_SYMBOLS_PER_REQUEST);
    const quotes: LiveQuote[] = [];
    let errors = 0;
    for (const [i, batch] of batches.entries()) {
      try {
        quotes.push(...(await this.fetchBatch(batch)));
      } catch {
        errors += 1;
      }
      // Pace the sweep so a 28-request burst stays well under a request/second.
      if (i < batches.length - 1 && this.pauseMs > 0) {
        await new Promise((r) => setTimeout(r, this.pauseMs));
      }
    }
    this.lastErrors = errors;
    return quotes;
  }

  private async fetchBatch(batch: string[]): Promise<LiveQuote[]> {
    const symbols = batch.map(toYahooSymbol).join(',');
    const url = `${SPARK}?symbols=${encodeURIComponent(symbols)}&range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`spark ${res.status}`);
    return parseSpark((await res.json()) as SparkResponse);
  }
}

export function getQuoteClient(): QuoteClient | null {
  if ((process.env.QUOTE_SOURCE ?? 'yahoo').toLowerCase() === 'off') return null;
  return new QuoteClient(Number(process.env.QUOTE_PAUSE_MS ?? 120));
}
