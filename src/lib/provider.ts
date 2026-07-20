/**
 * Data-provider abstraction. Three sources, one interface:
 *
 *   massive — Massive.com (formerly Polygon.io). Real-time on paid plans;
 *             free tier is 5 calls/min end-of-day. Needs MASSIVE_API_KEY.
 *   cboe    — CBOE's free delayed-quotes CDN. 15-minute-delayed chains with
 *             per-contract volume. No key, no account, no fee.
 *   demo    — built-in simulator (synthetic flow).
 *
 * Selection: DATA_PROVIDER env wins; otherwise an API key implies massive,
 * else cboe (free real data out of the box). DATA_PROVIDER=demo forces the
 * simulator.
 */
import type { ChainAnalytics, RawContract } from '@/types';
import type { TokenBucket } from './rate-limiter';

export interface OptionsChainAggregate {
  symbol: string;
  putVolume: number;
  callVolume: number;
  /** Notional premium traded today: Σ price × volume × 100. */
  putPremium: number;
  callPremium: number;
  underlyingPrice: number;
  priceChangePct: number;
  contractsSeen: number;
  /** Largest single-contract day volume seen — proxy for block activity. */
  largestContractVolume: number;
  /** 30-day IV (vol points) and day change, when the provider reports it. */
  iv30: number | null;
  iv30Change: number | null;
  /** Full normalized chain for analytics (omitted by the simulator). */
  contracts?: RawContract[];
  /** Pre-computed analytics (simulator only; live providers pass contracts). */
  analytics?: ChainAnalytics;
}

export interface OptionsDataProvider {
  /** Short id shown in the status bar: 'massive' | 'cboe'. */
  readonly name: string;
  readonly bucket: TokenBucket;
  getOptionsFlowSnapshot(symbol: string, priority?: number): Promise<OptionsChainAggregate>;
}

export type ProviderChoice = 'massive' | 'cboe' | 'demo';

export function resolveProviderChoice(): ProviderChoice {
  const explicit = (process.env.DATA_PROVIDER ?? '').toLowerCase();
  if (explicit === 'massive' || explicit === 'polygon') return 'massive';
  if (explicit === 'cboe') return 'cboe';
  if (explicit === 'demo' || explicit === 'sim' || explicit === 'simulator') return 'demo';
  const key = process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY ?? '';
  return key.length > 0 && key !== 'demo' ? 'massive' : 'cboe';
}
