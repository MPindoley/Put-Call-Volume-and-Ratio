/**
 * Schwab real-time option chains — the owner's own brokerage market data.
 *
 * GET {SCHWAB_API_BASE}/marketdata/v1/chains returns the whole chain with each
 * contract's day volume (totalVolume), bid/ask/last, and the underlying quote,
 * in real time. Schwab allows 120 market-data requests a minute per app; the
 * default SCHWAB_RPM=100 leaves headroom.
 *
 * Role: an OVERLAY for flow only. Schwab's chains drive put/call volumes, P/C,
 * premium and spike detection for a hot set of names (poller.ts). The
 * analytics of record — IV30, skew, OI, GEX, IV rank and everything the
 * learning loop is graded on — stay on the CBOE feed for every name, so the
 * history those are compared against keeps one methodology. Schwab computes
 * IV its own way; mixing the two would shift IV rank and the sector z-scores
 * for reasons that have nothing to do with the market.
 *
 * Personal use: Schwab licenses this data to the account holder. Keep the site
 * locked (SITE_PASSWORD) — real-time polling only runs when it is.
 */
import type { OptionsChainAggregate } from './provider';
import { PermanentError, TokenBucket, withBackoff } from './rate-limiter';
import type { SchwabAuth } from './schwab-auth';

/** How long to stop issuing tokens after a 429. */
const RATE_LIMIT_COOLDOWN_MS = 15_000;
/** Schwab's delayed feed (unentitled accounts) lags by this much. */
const SCHWAB_DELAY_MS = 15 * 60_000;

interface SchwabContract {
  putCall?: 'PUT' | 'CALL';
  bid?: number;
  ask?: number;
  last?: number;
  totalVolume?: number;
  quoteTimeInLong?: number;
  nonStandard?: boolean;
  mini?: boolean;
}

type ExpDateMap = Record<string, Record<string, SchwabContract[]>>;

export interface SchwabChainResponse {
  symbol?: string;
  status?: string;
  isDelayed?: boolean;
  isChainTruncated?: boolean;
  underlyingPrice?: number;
  underlying?: {
    last?: number;
    mark?: number;
    percentChange?: number;
    quoteTime?: number;
    tradeTime?: number;
    delayed?: boolean;
  };
  callExpDateMap?: ExpDateMap;
  putExpDateMap?: ExpDateMap;
}

export interface RealtimeChain {
  agg: OptionsChainAggregate;
  /** Schwab served delayed data (account not entitled to real-time options). */
  delayed: boolean;
  /** Venue time of the underlying quote, epoch ms (null when absent). */
  priceAt: number | null;
}

/** The chain is too big for one response; CBOE keeps covering this name. */
export class ChainTruncatedError extends PermanentError {}
/** No usable Schwab session (never connected, signed out, or the weekly sign-in lapsed). */
export class NotConnectedError extends PermanentError {}

/**
 * Totals from a Schwab chain, counted the way cboe.ts counts CBOE's: standard
 * contracts only (mini and adjusted/non-standard deliverables excluded),
 * premium at the bid/ask midpoint falling back to the last trade, ×100.
 */
export function normalizeSchwabChain(symbol: string, body: SchwabChainResponse, fetchedAt: number): RealtimeChain {
  if (body.status && body.status !== 'SUCCESS') throw new PermanentError(`schwab: no chain for ${symbol} (${body.status})`);
  if (body.isChainTruncated) throw new ChainTruncatedError(`schwab: chain for ${symbol} truncated`);
  const u = body.underlying;
  const delayed = Boolean(body.isDelayed || u?.delayed);
  const agg: OptionsChainAggregate = {
    symbol,
    putVolume: 0,
    callVolume: 0,
    putPremium: 0,
    callPremium: 0,
    underlyingPrice: body.underlyingPrice ?? u?.last ?? u?.mark ?? 0,
    priceChangePct: u?.percentChange ?? 0,
    contractsSeen: 0,
    largestContractVolume: 0,
    iv30: null,
    iv30Change: null,
  };
  let latestQuote = 0;
  for (const map of [body.callExpDateMap, body.putExpDateMap]) {
    for (const strikes of Object.values(map ?? {})) {
      for (const contracts of Object.values(strikes)) {
        for (const c of contracts) {
          if (c.mini || c.nonStandard) continue;
          if ((c.quoteTimeInLong ?? 0) > latestQuote) latestQuote = c.quoteTimeInLong ?? 0;
          const volume = c.totalVolume ?? 0;
          if (!(volume > 0)) continue;
          const bid = c.bid ?? 0;
          const ask = c.ask ?? 0;
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (c.last ?? 0);
          const premium = mid * volume * 100;
          if (c.putCall === 'PUT') {
            agg.putVolume += volume;
            agg.putPremium += premium;
          } else if (c.putCall === 'CALL') {
            agg.callVolume += volume;
            agg.callPremium += premium;
          } else continue;
          agg.contractsSeen += 1;
          agg.largestContractVolume = Math.max(agg.largestContractVolume, volume);
        }
      }
    }
  }
  // Real-time totals describe the moment they were fetched. A delayed chain
  // describes its newest quote (or, failing that, fetch time minus the delay).
  agg.asOf = delayed
    ? latestQuote > fetchedAt - 86_400_000 && latestQuote <= fetchedAt
      ? latestQuote
      : fetchedAt - SCHWAB_DELAY_MS
    : fetchedAt;
  const priceAt = u?.tradeTime ?? u?.quoteTime ?? null;
  return { agg, delayed, priceAt: priceAt && priceAt > 0 ? Math.min(priceAt, fetchedAt) : null };
}

export class SchwabClient {
  readonly name = 'schwab';
  readonly bucket: TokenBucket;

  constructor(
    private auth: SchwabAuth,
    callsPerMinute: number,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    this.bucket = new TokenBucket(callsPerMinute);
  }

  async getRealtimeChain(symbol: string, priority = 5): Promise<RealtimeChain> {
    const url =
      `${this.auth.cfg.apiBase}/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}` +
      '&contractType=ALL&includeUnderlyingQuote=true&strategy=SINGLE';
    const body = await withBackoff(
      async () => {
        const token = await this.auth.getAccessToken();
        if (!token) throw new NotConnectedError('schwab not connected');
        await this.bucket.acquire(priority);
        const res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.status === 401) {
          // Revoked or expired early: refresh before the retry.
          this.auth.invalidateAccess();
          throw new Error('schwab 401');
        }
        if (res.status === 429) {
          this.bucket.penalize(RATE_LIMIT_COOLDOWN_MS);
          throw new Error('rate limited (429)');
        }
        if (res.status === 400 || res.status === 404) throw new PermanentError(`schwab ${res.status} for ${symbol}`);
        if (!res.ok) throw new Error(`schwab ${res.status} for ${symbol}`);
        return (await res.json()) as SchwabChainResponse;
      },
      // Few, quick retries: a real-time snapshot is worth less with every second of delay.
      { retries: 2, baseDelayMs: 1_000, label: `schwab/${symbol}` },
    );
    return normalizeSchwabChain(symbol, body, Date.now());
  }
}
