/**
 * The real-time overlay loop: Schwab chains for a hot set of names, alongside
 * the delayed feed of record that keeps covering every name (poller.ts).
 *
 * Schwab allows ~120 requests a minute, so not all ~1,400 names can be real
 * time; a full chain per name per minute or two is affordable for a couple of
 * hundred. The hot set is the names where minutes matter: the watchlist,
 * index benchmarks, anything flagged unusual, and the most active names by
 * option volume. Membership has hysteresis — a name enters in the top
 * SCHWAB_HOT_SYMBOLS and leaves only below 1.5× that rank — so names near the
 * cut-off do not flap in and out, each time losing the two snapshots a
 * real-time rate needs.
 *
 * Within the hot set the refresh order is the same tiered, overdue-first
 * schedule as the delayed feed (refresh-schedule.ts), at real-time intervals.
 *
 * Every failure degrades to the delayed feed for that name, never to a gap:
 * the engine keeps the delayed figures until a real-time window exists and
 * takes them back 10 minutes after real-time data stops (flow-engine.ts).
 */
import type { RealtimeFeedInfo, TickerFlow } from '@/types';
import type { FlowEngine } from './flow-engine';
import { PermanentError } from './rate-limiter';
import { planRefresh, type RefreshCandidate, type ScheduleConfig } from './refresh-schedule';
import { ChainTruncatedError, NotConnectedError, type SchwabClient } from './schwab';
import type { SchwabAuth } from './schwab-auth';
import { siteLocked } from './session';
import { etDateKey } from './trading-calendar';

const MIN = 60_000;

/** Real-time tiers: the busiest 50 about every minute, the next 150 every two, at ~100 requests/min. */
export const REALTIME_SCHEDULE: ScheduleConfig = {
  tier1Size: 50,
  tier2Size: 150,
  baseIntervalsMs: [1 * MIN, 2 * MIN, 5 * MIN],
};

/** A member stays in the hot set while it ranks within size × this. */
const KEEP_FACTOR = 1.5;
/** How often to look again without a usable sign-in — short, so a fresh Connect takes effect quickly. */
const SIGNED_OUT_RECHECK_MS = 15_000;
/** How often to look again while the market is closed. */
const IDLE_RECHECK_MS = 60_000;

export interface HotSetInput {
  universe: readonly string[];
  /** Option volume today (else the last recorded day's); 0 = unknown. */
  activity: (symbol: string) => number;
  /** Always included while in the universe: watchlist, benchmarks, spiking names. */
  always: ReadonlySet<string>;
  size: number;
  previous: ReadonlySet<string>;
  /** Names the real-time source cannot serve this session. */
  exclude: ReadonlySet<string>;
}

/** Pure: the names the real-time loop rotates through. */
export function pickHotSet({ universe, activity, always, size, previous, exclude }: HotSetInput): Set<string> {
  const ranked = universe
    .filter((s) => !exclude.has(s) && activity(s) > 0)
    .sort((a, b) => activity(b) - activity(a) || a.localeCompare(b));
  const keepRank = Math.ceil(size * KEEP_FACTOR);
  const out = new Set<string>();
  for (const s of universe) if (always.has(s) && !exclude.has(s)) out.add(s);
  ranked.forEach((s, rank) => {
    if (rank < size || (previous.has(s) && rank < keepRank)) out.add(s);
  });
  return out;
}

export interface RealtimeFeedOptions {
  intervalMs: number;
  hotSize: number;
  concurrency: number;
  universe: () => readonly string[];
  activity: (symbol: string) => number;
  /** Watchlist + benchmarks; spiking names are added from the engine. */
  pinned: () => { watch: ReadonlySet<string>; benchmarks: ReadonlySet<string> };
  /** Same idle rule as the delayed loop (market closed). */
  shouldIdle: () => boolean;
  /** Finalize, broadcast and persist updated rows (poller.ts). */
  publish: (updated: TickerFlow[]) => Promise<void>;
}

export class RealtimeFeed {
  private lastFetched = new Map<string, number>();
  private hot = new Set<string>();
  private unsupported = new Set<string>();
  private sessionDay = 0;
  private delayed = false;
  private lastError: string | null = null;
  private lastFetchAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private startedAt = Date.now();
  private announced: RealtimeFeedInfo['state'] | null = null;
  /** Last known end of the weekly sign-in (kept for the idle report). */
  private reconnectBy: number | null = null;

  constructor(
    private engine: FlowEngine,
    private auth: SchwabAuth,
    private client: SchwabClient,
    private opts: RealtimeFeedOptions,
  ) {
    // Placeholder until the first pass learns the real state (not logged).
    this.report('signed-out', null, false);
  }

  start(delayMs: number): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const started = Date.now();
    let waitMs = this.opts.intervalMs;
    try {
      waitMs = await this.cycle();
    } catch (err) {
      console.error('[realtime] cycle failed:', err instanceof Error ? err.message : err);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), Math.max(0, waitMs - (Date.now() - started)));
  }

  /** One pass; returns how long to wait (from its start) before the next. */
  async cycle(): Promise<number> {
    if (!siteLocked()) {
      this.report('unlocked', null);
      return SIGNED_OUT_RECHECK_MS;
    }
    // Market closed: idle without touching the database, so a database that
    // scales to zero (Neon) can sleep overnight instead of being woken every
    // few seconds to re-read the sign-in.
    if (this.opts.shouldIdle()) {
      this.report('idle', this.reconnectBy);
      return IDLE_RECHECK_MS;
    }
    const status = await this.auth.status();
    this.reconnectBy = status.reconnectBy;
    if (status.state !== 'connected') {
      this.report(status.state === 'expired' ? 'expired' : 'signed-out', status.reconnectBy);
      return SIGNED_OUT_RECHECK_MS;
    }

    const now = Date.now();
    const day = etDateKey(new Date(now)).getTime();
    if (day !== this.sessionDay) {
      // A chain too large today may not be tomorrow; give every name a fresh chance.
      this.unsupported.clear();
      this.sessionDay = day;
    }
    const { watch, benchmarks } = this.opts.pinned();
    const universe = this.opts.universe();
    const spiking = new Set(universe.filter((s) => (this.engine.getFlow(s)?.spikeLevel ?? 'normal') !== 'normal'));
    this.hot = pickHotSet({
      universe,
      activity: this.opts.activity,
      always: new Set([...watch, ...benchmarks, ...spiking]),
      size: this.opts.hotSize,
      previous: this.hot,
      exclude: this.unsupported,
    });

    const perMinute = this.client.bucket.currentPerMinute;
    const budget = Math.max(1, Math.floor((perMinute * this.opts.intervalMs) / MIN));
    const candidates: RefreshCandidate[] = [...this.hot].map((symbol) => ({
      symbol,
      lastFetched: this.lastFetched.get(symbol) ?? 0,
      activity: this.opts.activity(symbol),
      watch: watch.has(symbol),
      spiking: spiking.has(symbol),
      benchmark: benchmarks.has(symbol),
    }));
    const batch = planRefresh(candidates, budget, perMinute, now, REALTIME_SCHEDULE, this.startedAt);

    const updated: TickerFlow[] = [];
    let failures = 0;
    let signedOut = false;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length && !signedOut) {
        const item = batch[cursor++];
        if (!item) break;
        this.lastFetched.set(item.symbol, Date.now());
        try {
          const chain = await this.client.getRealtimeChain(item.symbol, item.priority);
          this.delayed = chain.delayed;
          this.lastFetchAt = Date.now();
          updated.push(this.engine.ingestRealtime(chain.agg, this.lastFetchAt, chain.priceAt));
        } catch (err) {
          if (err instanceof NotConnectedError) {
            signedOut = true;
            break;
          }
          failures += 1;
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = `${item.symbol}: ${msg}`;
          if (err instanceof PermanentError) {
            // Not servable today (no chain, or too large to return whole): the
            // delayed feed keeps covering it, and the slot goes to another name.
            this.unsupported.add(item.symbol);
            if (!(err instanceof ChainTruncatedError)) console.warn(`[realtime] ${msg}`);
          } else {
            console.warn(`[realtime] ${item.symbol} failed: ${msg}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, batch.length) }, worker));
    if (failures === 0 && updated.length > 0) this.lastError = null;

    const after = await this.auth.status();
    this.report(after.state === 'connected' ? 'polling' : after.state === 'expired' ? 'expired' : 'signed-out', after.reconnectBy);
    if (updated.length > 0) await this.opts.publish(updated);
    return signedOut ? SIGNED_OUT_RECHECK_MS : this.opts.intervalMs;
  }

  private report(state: RealtimeFeedInfo['state'], reconnectBy: number | null, log = true): void {
    if (log && state !== this.announced) {
      this.announced = state;
      const why: Record<RealtimeFeedInfo['state'], string> = {
        polling: `polling ${this.hot.size} names in real time`,
        idle: 'market closed — idling',
        'signed-out': 'not signed in to Schwab — delayed feed only (connect on the Data sources page)',
        expired: 'Schwab sign-in expired — delayed feed only until you reconnect',
        unlocked: 'SITE_PASSWORD is not set — real-time stays off (the data is licensed to you alone)',
      };
      console.log(`[realtime] ${why[state]}`);
    }
    this.engine.realtimeFeed = {
      source: 'schwab',
      state,
      liveTickers: 0, // counted at read time (FlowEngine.realtimeInfo)
      hotSetSize: this.hot.size,
      lastFetchAt: this.lastFetchAt,
      callsLastMinute: this.client.bucket.callsLastMinute(),
      perMinute: this.client.bucket.currentPerMinute,
      delayed: this.delayed,
      lastError: this.lastError ?? this.auth.lastError,
      unsupported: this.unsupported.size,
      reconnectBy,
    };
  }
}
