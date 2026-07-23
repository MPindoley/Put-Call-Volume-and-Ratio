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
  data?: {
    options?: CboeContract[];
    current_price?: number;
    price_change_percent?: number;
    iv30?: number;
    iv30_change?: number;
  };
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
    await this.bucket.acquire(priority);
    return withBackoff(
      async () => {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (res.status === 429) throw new Error('rate limited (429)');
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
