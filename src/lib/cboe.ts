/**
 * CBOE free delayed-quotes provider. Zero fees, no API key.
 *
 * https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json returns
 * the full option chain (per-contract day volume, bid/ask, last trade) plus
 * the underlying's current price — 15 minutes delayed. That's enough for
 * P/C ratios, premium estimates and spike detection; only tick-level tactics
 * (sweep detection, sub-15-min reaction) need a paid real-time feed.
 *
 * Politeness: default CBOE_RPM=60. It's a public CDN, not a metered API, but
 * we keep the same token-bucket + backoff discipline as the paid provider.
 */
import type { OptionsChainAggregate, OptionsDataProvider } from './provider';
import { TokenBucket, withBackoff } from './rate-limiter';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

interface CboeContract {
  /** OCC-style id, e.g. "AAPL260117C00150000" — C/P sits 9 chars from the end. */
  option?: string;
  volume?: number;
  bid?: number;
  ask?: number;
  last_trade_price?: number;
}

interface CboeResponse {
  data?: {
    options?: CboeContract[];
    current_price?: number;
    price_change_percent?: number;
  };
}

function contractType(occ: string): 'call' | 'put' | null {
  if (occ.length < 9) return null;
  const ch = occ[occ.length - 9];
  return ch === 'C' ? 'call' : ch === 'P' ? 'put' : null;
}

export class CboeClient implements OptionsDataProvider {
  readonly name = 'cboe';
  readonly bucket: TokenBucket;

  constructor(callsPerMinute: number) {
    this.bucket = new TokenBucket(callsPerMinute);
  }

  async getOptionsFlowSnapshot(symbol: string, priority = 5): Promise<OptionsChainAggregate> {
    await this.bucket.acquire(priority);
    const data = await withBackoff(
      async () => {
        const res = await fetch(`${BASE}/${encodeURIComponent(symbol)}.json`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.status === 429) throw new Error('rate limited (429)');
        if (!res.ok) throw new Error(`cboe ${res.status} for ${symbol}`);
        return (await res.json()) as CboeResponse;
      },
      { label: `cboe/${symbol}` },
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
    };

    for (const c of data.data?.options ?? []) {
      const volume = c.volume ?? 0;
      if (volume <= 0 || !c.option) continue;
      const type = contractType(c.option);
      if (!type) continue;
      const bid = c.bid ?? 0;
      const ask = c.ask ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (c.last_trade_price ?? 0);
      const premium = mid * volume * 100;
      if (type === 'put') {
        agg.putVolume += volume;
        agg.putPremium += premium;
      } else {
        agg.callVolume += volume;
        agg.callPremium += premium;
      }
      agg.contractsSeen += 1;
      agg.largestContractVolume = Math.max(agg.largestContractVolume, volume);
    }
    return agg;
  }
}
