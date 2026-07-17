/**
 * Massive.com REST client (formerly Polygon.io — same API, keys and plans;
 * api.polygon.io and api.massive.com run in parallel). Server-side only —
 * the API key never leaves this process. All calls flow through a shared
 * token bucket sized to MASSIVE_RPM.
 */
import type { OptionsChainAggregate, OptionsDataProvider } from './provider';
import { TokenBucket, withBackoff } from './rate-limiter';

const BASE = process.env.MASSIVE_BASE_URL ?? 'https://api.massive.com';

export interface PrevDayAgg {
  symbol: string;
  close: number;
  volume: number;
}

interface MassiveOptionContract {
  details?: { contract_type?: string; strike_price?: number; expiration_date?: string };
  day?: { volume?: number; vwap?: number; close?: number };
  last_quote?: { midpoint?: number };
  underlying_asset?: { price?: number };
}

interface MassiveSnapshotResponse {
  status?: string;
  results?: MassiveOptionContract[];
  next_url?: string | null;
}

interface MassivePrevResponse {
  status?: string;
  results?: { c?: number; v?: number; o?: number }[];
}

export class MassiveClient implements OptionsDataProvider {
  readonly name = 'massive';
  readonly bucket: TokenBucket;
  private readonly apiKey: string;

  constructor(apiKey: string, callsPerMinute: number) {
    this.apiKey = apiKey;
    this.bucket = new TokenBucket(callsPerMinute);
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 && this.apiKey !== 'demo';
  }

  private async get<T>(path: string, priority: number): Promise<T> {
    await this.bucket.acquire(priority);
    return withBackoff(
      async () => {
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(`${BASE}${path}${sep}apiKey=${this.apiKey}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.status === 429) throw new Error('rate limited (429)');
        if (!res.ok) throw new Error(`massive ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
        return (await res.json()) as T;
      },
      { label: path.split('?')[0] ?? path },
    );
  }

  /**
   * Aggregate today's options flow for one underlying from the chain snapshot.
   * Uses /v3/snapshot/options/{ticker}; paginates only for high-priority
   * tickers to preserve rate budget (first 250 contracts are sorted by
   * activity and dominate volume).
   */
  async getOptionsFlowSnapshot(symbol: string, priority = 5, maxPages = 1): Promise<OptionsChainAggregate> {
    const agg: OptionsChainAggregate = {
      symbol,
      putVolume: 0,
      callVolume: 0,
      putPremium: 0,
      callPremium: 0,
      underlyingPrice: 0,
      priceChangePct: 0,
      contractsSeen: 0,
      largestContractVolume: 0,
    };

    let path: string | null = `/v3/snapshot/options/${encodeURIComponent(symbol)}?limit=250`;
    for (let page = 0; page < maxPages && path; page++) {
      const data: MassiveSnapshotResponse = await this.get<MassiveSnapshotResponse>(path, priority);
      for (const contract of data.results ?? []) {
        const volume = contract.day?.volume ?? 0;
        if (volume <= 0) continue;
        const price = contract.day?.vwap ?? contract.day?.close ?? contract.last_quote?.midpoint ?? 0;
        const premium = price * volume * 100;
        const type = contract.details?.contract_type;
        if (type === 'put') {
          agg.putVolume += volume;
          agg.putPremium += premium;
        } else if (type === 'call') {
          agg.callVolume += volume;
          agg.callPremium += premium;
        }
        agg.contractsSeen += 1;
        agg.largestContractVolume = Math.max(agg.largestContractVolume, volume);
        const px = contract.underlying_asset?.price;
        if (px && px > 0) agg.underlyingPrice = px;
      }
      path = data.next_url ? data.next_url.replace(BASE, '') : null;
    }
    return agg;
  }

  /** Previous trading day OHLCV for the underlying — historical volume context. */
  async getPrevDay(symbol: string, priority = 5): Promise<PrevDayAgg | null> {
    const data = await this.get<MassivePrevResponse>(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true`,
      priority,
    );
    const bar = data.results?.[0];
    if (!bar || bar.c === undefined) return null;
    return { symbol, close: bar.c, volume: bar.v ?? 0 };
  }
}
