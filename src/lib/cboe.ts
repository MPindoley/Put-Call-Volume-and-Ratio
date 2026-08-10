/**
 * CBOE free delayed-quotes provider. Zero fees, no API key.
 *
 * https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json returns
 * the full option chain — per-contract day volume, bid/ask, IV, delta, gamma
 * and open interest — plus the underlying's price and 30-day IV, 15 minutes
 * delayed. That powers P/C ratios, premium, spike detection AND the analytics
 * layer (skew, term structure, OI, max pain, GEX). The same CDN also serves
 * index quotes (VIX, VIX3M) and ~20 years of daily OHLC history per symbol
 * (used to compute realized volatility).
 *
 * Politeness: default CBOE_RPM=60. It's a public CDN, not a metered API, but
 * we keep the same token-bucket + backoff discipline as the paid provider.
 */
import type { RawContract } from '@/types';
import type { OptionsChainAggregate, OptionsDataProvider } from './provider';
import { TokenBucket, withBackoff } from './rate-limiter';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes';

/**
 * How long to stop issuing tokens after the CDN returns 429. Long enough that
 * the in-flight burst drains before we probe again, short enough that a single
 * blip does not cost a whole rotation.
 */
const RATE_LIMIT_COOLDOWN_MS = 15_000;

interface CboeContract {
  /** OCC-style id, e.g. "AAPL260117C00150000". */
  option?: string;
  volume?: number;
  bid?: number;
  ask?: number;
  last_trade_price?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  open_interest?: number;
}

interface CboeResponse {
  /** Snapshot generation time, UTC, "YYYY-MM-DD HH:MM:SS". */
  timestamp?: string;
  data?: {
    options?: CboeContract[];
    current_price?: number;
    price_change_percent?: number;
    iv30?: number;
    iv30_change?: number;
  };
}

/**
 * A name that stops trading does not disappear from this CDN. CBOE keeps
 * serving its last snapshot indefinitely — plausible price, HTTP 200, no error
 * — so a delisted ticker reads exactly like a live one. Measured on the live
 * feed: DFS frozen 450 days at $198.10, BK 81 days at $137.16, both with an
 * empty option chain. Ingesting those shows a ghost price as if it were today.
 *
 * The payload's own timestamp is the only reliable liveness signal, so refuse a
 * snapshot that is clearly frozen rather than publishing a stale number.
 * The threshold is deliberately generous — a long weekend plus a holiday is
 * ~4 days, and the poller idles while the market is closed anyway.
 */
export const MAX_SNAPSHOT_AGE_MS = 5 * 86_400_000;

/**
 * Age of a CBOE snapshot, or null when the stamp is absent or unparseable.
 * Null means "cannot tell" and callers must fail OPEN: a CDN format change
 * must never take the whole feed down.
 */
export function snapshotAgeMs(timestamp: string | undefined, now = Date.now()): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(`${timestamp.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? now - ms : null;
}

interface CboeIndexQuote {
  data?: { current_price?: number; close?: number };
}

interface CboeHistoryResponse {
  data?: { date?: string; close?: number }[];
}

/** Parse an OCC symbol: root + YYMMDD + C/P + strike×1000 (8 digits). */
export function parseOcc(occ: string): { type: 'call' | 'put'; strike: number; expiration: number } | null {
  if (occ.length < 16) return null;
  const strikeRaw = occ.slice(-8);
  const typeCh = occ[occ.length - 9];
  const dateRaw = occ.slice(-15, -9);
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (typeCh !== 'C' && typeCh !== 'P') return null;
  const year = 2000 + Number(dateRaw.slice(0, 2));
  const month = Number(dateRaw.slice(2, 4));
  const day = Number(dateRaw.slice(4, 6));
  if (!month || !day) return null;
  return {
    type: typeCh === 'C' ? 'call' : 'put',
    strike,
    expiration: Date.UTC(year, month - 1, day),
  };
}

export class CboeClient implements OptionsDataProvider {
  readonly name = 'cboe';
  readonly bucket: TokenBucket;

  constructor(callsPerMinute: number) {
    this.bucket = new TokenBucket(callsPerMinute);
  }

  private async get<T>(url: string, priority: number, label: string): Promise<T> {
    return withBackoff(
      async () => {
        // Acquire INSIDE the retry, so every attempt is metered. Acquiring once
        // outside let a single token buy up to `retries + 1` real requests — at
        // CBOE_RPM=60 that is a true ceiling of ~300/min, which is what pushed
        // the CDN into 429s, whose retries then compounded the overshoot.
        await this.bucket.acquire(priority);
        const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (res.status === 429) {
          // Slow the whole client down, not just this request.
          this.bucket.penalize(RATE_LIMIT_COOLDOWN_MS);
          throw new Error('rate limited (429)');
        }
        if (!res.ok) throw new Error(`cboe ${res.status} for ${label}`);
        return (await res.json()) as T;
      },
      { label },
    );
  }

  async getOptionsFlowSnapshot(symbol: string, priority = 5): Promise<OptionsChainAggregate> {
    const data = await this.get<CboeResponse>(
      `${BASE}/options/${encodeURIComponent(symbol)}.json`,
      priority,
      `cboe/${symbol}`,
    );

    // Refuse a frozen snapshot (delisted/halted name) instead of publishing a
    // ghost price. Null age = cannot tell → proceed, never fail the feed.
    const age = snapshotAgeMs(data.timestamp);
    if (age !== null && age > MAX_SNAPSHOT_AGE_MS) {
      throw new Error(
        `stale snapshot for ${symbol}: ${(age / 86_400_000).toFixed(0)}d old — delisted or halted?`,
      );
    }

    const agg: OptionsChainAggregate = {
      symbol,
      putVolume: 0,
      callVolume: 0,
      putPremium: 0,
      callPremium: 0,
      underlyingPrice: data.data?.current_price ?? 0,
      priceChangePct: data.data?.price_change_percent ?? 0,
      contractsSeen: 0,
      largestContractVolume: 0,
      iv30: data.data?.iv30 && data.data.iv30 > 0 ? data.data.iv30 : null,
      iv30Change: data.data?.iv30_change ?? null,
      contracts: [],
    };

    for (const c of data.data?.options ?? []) {
      if (!c.option) continue;
      const parsed = parseOcc(c.option);
      if (!parsed) continue;
      const volume = c.volume ?? 0;
      const bid = c.bid ?? 0;
      const ask = c.ask ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (c.last_trade_price ?? 0);

      if (volume > 0) {
        const premium = mid * volume * 100;
        if (parsed.type === 'put') {
          agg.putVolume += volume;
          agg.putPremium += premium;
        } else {
          agg.callVolume += volume;
          agg.callPremium += premium;
        }
        agg.contractsSeen += 1;
        agg.largestContractVolume = Math.max(agg.largestContractVolume, volume);
      }

      // Keep every contract with any analytic value (OI or a live IV quote).
      if ((c.open_interest ?? 0) > 0 || (c.iv ?? 0) > 0 || volume > 0) {
        const contract: RawContract = {
          type: parsed.type,
          strike: parsed.strike,
          expiration: parsed.expiration,
          iv: c.iv ?? 0,
          delta: c.delta ?? 0,
          gamma: c.gamma ?? 0,
          openInterest: c.open_interest ?? 0,
          volume,
          mid,
          bid: bid > 0 ? bid : undefined,
          ask: ask > 0 ? ask : undefined,
        };
        agg.contracts?.push(contract);
      }
    }
    return agg;
  }

  /** Index level (e.g. _VIX, _VIX3M) from the index-quote endpoint. */
  async getIndexQuote(symbol: string, priority = 1): Promise<number | null> {
    try {
      const data = await this.get<CboeIndexQuote>(
        `${BASE}/quotes/${encodeURIComponent(symbol)}.json`,
        priority,
        `cboe-quote/${symbol}`,
      );
      const px = data.data?.current_price ?? data.data?.close ?? null;
      return px && px > 0 ? px : null;
    } catch {
      return null;
    }
  }

  /** Daily closes (ascending) for realized-vol calculations. */
  async getDailyCloses(symbol: string, days = 80, priority = 8): Promise<number[]> {
    return (await this.getDailyClosesDated(symbol, days, priority)).map((d) => d.close);
  }

  /** Dated daily closes (ascending), for historical backfill keyed by date. */
  async getDailyClosesDated(
    symbol: string,
    days = 120,
    priority = 8,
  ): Promise<{ date: Date; close: number }[]> {
    const data = await this.get<CboeHistoryResponse>(
      `${BASE}/charts/historical/${encodeURIComponent(symbol)}.json`,
      priority,
      `cboe-hist/${symbol}`,
    );
    return (data.data ?? [])
      .filter((d) => d.date && (d.close ?? 0) > 0)
      .map((d) => ({ date: new Date(`${d.date}T00:00:00Z`), close: d.close as number }))
      .filter((d) => !Number.isNaN(d.date.getTime()))
      .slice(-days);
  }
}
