/**
 * Polling service. Every POLL_INTERVAL_SEC it refreshes as many tickers as the
 * rate budget allows, prioritizing (1) watchlist symbols, (2) tickers already
 * spiking, (3) the least-recently-updated of the rest — so on rate-limited
 * sources (Massive free tier, polite CBOE pacing) the universe cycles fairly
 * while hot names stay fresh.
 *
 * In demo mode (DATA_PROVIDER=demo) the simulator refreshes every ticker
 * every cycle at zero API cost.
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { CboeClient } from './cboe';
import { getDataProvider } from './data-source';
import { refreshEdgarConfirmations } from './event-jobs';
import { getFlowEngine, type FlowEngine } from './flow-engine';
import {
  backfillCloseHistory,
  maintenanceWindow,
  maybeCaptureEndOfDay,
  persistAlert,
  runMaintenance,
  seedTickers,
  upsertFlowSnapshots,
} from './history-jobs';
import { loadInstrumentConfigs } from './interpretation';
import { backfillRegimeHistory } from './regime-jobs';
import { loadConvictionsIntoEngine } from './learning-jobs';
import { refreshProjectionHistory } from './projection-jobs';
import { loadLatestIntoEngine } from './sector-analytics';
import { getQuoteClient, pickQuoteSymbols, type QuoteClient } from './quotes';
import { RealtimeFeed } from './realtime-feed';
import { SchwabClient } from './schwab';
import { getSchwabAuth } from './schwab-auth';
import { FlowSimulator } from './simulator';
import { isTradingDayNow, lastSessionClose } from './trading-calendar';
import { planRefresh, staleForClose, type RefreshCandidate } from './refresh-schedule';
import { restoreEngineSnapshot, saveEngineSnapshot, SNAPSHOT_EVERY_MS } from './engine-snapshot';
import { BENCHMARKS, TRACKED_UNIVERSE } from './universe';
import { isMarketHours } from './utils';
import { tryDb, dbAvailable } from './db';
import type { ServerToClientEvents, ClientToServerEvents, QuoteTick, TickerFlow } from '@/types';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

const CONCURRENCY = 10;
const BENCHMARK_SYMBOLS = new Set(BENCHMARKS.map((b) => b.symbol));

export class Poller {
  private engine: FlowEngine;
  private simulator = new FlowSimulator();
  /** Last fetch ATTEMPT per symbol (successful or not), for scheduling. */
  private lastFetched = new Map<string, number>();
  /** Last recorded session option volume per symbol (DB), to rank names before today's first fetch. */
  private priorActivity = new Map<string, number>();
  private running = false;
  private quoting = false;
  private lastFullQuoteSweep = 0;
  private quotes: QuoteClient | null = getQuoteClient();
  private quoteTask: cron.ScheduledTask | null = null;
  private marketWasOpen: boolean | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** When polling began; never-fetched names count as due since then (refresh-schedule.ts). */
  private startedAt = Date.now();
  private maintenanceTask: cron.ScheduledTask | null = null;
  private eodTask: cron.ScheduledTask | null = null;
  private edgarTask: cron.ScheduledTask | null = null;
  /** Schwab real-time overlay for the hot set (realtime-feed.ts); null when not configured. */
  private realtime: RealtimeFeed | null = null;
  /** Resolves once the saved table is restored and any catch-up is planned; cycles wait on it. */
  private ready: Promise<void> = Promise.resolve();
  /** Names still to refresh in an after-hours catch-up to the last close; null when none is running. */
  private catchUp: Set<string> | null = null;
  private lastSnapshotAt = Date.now();
  /** The session just ended while polling: save the table's closing state once. */
  private saveAtClose = false;

  constructor(private io: IO | null) {
    this.engine = getFlowEngine();
  }

  start(): void {
    this.startedAt = Date.now();
    const intervalSec = Math.max(15, Number(process.env.POLL_INTERVAL_SEC ?? 30));
    const provider = getDataProvider();
    this.engine.mode = provider ? 'live' : 'simulated';
    this.engine.dbConnected = dbAvailable();
    console.log(
      `[poller] starting: source=${provider?.name ?? 'simulator'}, interval=${intervalSec}s, ` +
        `universe=${TRACKED_UNIVERSE.length} tickers, rate=${provider ? `${provider.bucket.perMinute}/min` : 'n/a'}`,
    );

    // Every fired alert is persisted for the accuracy scoreboard.
    this.engine.onAlert((alert) => void persistAlert(alert));

    // Restore the last saved table before anything polls or captures, and plan
    // an after-hours catch-up if it does not hold the last session's close.
    this.lastSnapshotAt = Date.now();
    this.ready = this.prepare().catch((err) => console.error('[poller] restore failed:', err));

    void this.loadStoredState().then(async () => {
      await backfillCloseHistory(this.engine);
      await backfillRegimeHistory(); // seed vol+trend regime history (gamma null) once
      await runMaintenance(this.engine);
    });
    // Give the health probe a clean window before the first heavy cycle: a
    // chain fetch parses multi-MB JSON and blocks the event loop in bursts, so
    // firing it the instant the port opens can still starve the platform's
    // first healthcheck and get the deploy killed.
    const warmupMs = Math.max(0, Number(process.env.POLL_WARMUP_MS ?? 8_000));
    // Cycles run back to back (next one starts when this one ends, or at the
    // interval if it ended early) rather than on a fixed cron tick. A cycle's
    // batch is one interval's worth of rate budget, and the token bucket paces
    // it at exactly that rate, so a cycle always runs slightly OVER the
    // interval; on a fixed tick the next tick then found it still running and
    // was skipped, idling the budget for a whole interval — measured at roughly
    // half the configured request rate actually used.
    this.loopTimer = setTimeout(() => void this.loop(intervalSec * 1000), warmupMs);

    // Real-time overlay (Schwab) for the hot set, on its own loop and rate
    // budget. Live data only: never mixed into the simulator.
    const schwab = getSchwabAuth();
    if (schwab && provider) {
      const rpm = Math.max(1, Number(process.env.SCHWAB_RPM ?? 100));
      const hotSize = Math.max(1, Number(process.env.SCHWAB_HOT_SYMBOLS ?? 200));
      this.realtime = new RealtimeFeed(this.engine, schwab, new SchwabClient(schwab, rpm), {
        intervalMs: Math.max(10, Number(process.env.SCHWAB_INTERVAL_SEC ?? 20)) * 1000,
        hotSize,
        concurrency: 4,
        universe: () => TRACKED_UNIVERSE.map((u) => u.symbol),
        activity: (s) => this.activityOf(s),
        pinned: () => ({ watch: new Set(this.engine.settings.watchlist), benchmarks: BENCHMARK_SYMBOLS }),
        shouldIdle: () => this.shouldIdle(),
        publish: (updated) => this.publish(updated),
      });
      console.log(`[poller] real-time overlay: schwab, ${rpm}/min, hot set ${hotSize} names`);
      this.realtime.start(warmupMs + 4_000);
    }

    // Live-quote sweep on its own, much faster cadence: the hot set every pass,
    // the whole universe every few minutes (see quoteCycle), so price freshness
    // is independent of the chain rotation.
    if (this.quotes) {
      const quoteSec = Math.max(15, Number(process.env.QUOTE_INTERVAL_SEC ?? 60));
      console.log(
        `[poller] live quotes: ${this.quotes.name}, hot set every ${quoteSec}s, all ${TRACKED_UNIVERSE.length} symbols every ` +
          `${Math.max(60, Number(process.env.QUOTE_FULL_SWEEP_SEC ?? 300))}s`,
      );
      // Staggered after the chain warmup so the two sweeps do not both land
      // on top of the healthcheck window.
      setTimeout(() => void this.quoteCycle(), warmupMs + 2_000).unref();
      this.quoteTask = cron.schedule(`*/${quoteSec} * * * * *`, () => void this.quoteCycle());
    }
    // Baselines, alert scoring, provisional metrics and retention: every 2 hours
    // while there can be new work (trading days, 9:00–21:00 ET), not overnight
    // or at weekends, when nothing they read changes.
    this.maintenanceTask = cron.schedule('11 */2 * * *', () => {
      if (this.engine.mode === 'simulated' || maintenanceWindow()) void runMaintenance(this.engine);
    });
    // Pinned end-of-day capture: checked every 5 min; fires once in the
    // post-close ET window (self-gated on the trading calendar).
    this.eodTask = cron.schedule('*/5 * * * *', () => void maybeCaptureEndOfDay(this.engine));
    // SEC EDGAR earnings confirmation for the configured priority list: once daily
    // (cached + throttled; no-ops when no tickers are configured).
    this.edgarTask = cron.schedule('23 5 * * *', () => void refreshEdgarConfirmations());
  }

  /**
   * Sweep live underlying prices and push them as compact ticks. Every pass
   * covers the hot set (benchmarks, watchlist, most active names); the whole
   * universe is covered every QUOTE_FULL_SWEEP_SEC (pickQuoteSymbols). Kept
   * independent of cycle(): it must not wait on the chain rotation, and a quote
   * failure must not disturb chain polling (or vice versa). Idles outside
   * trading hours on the same rule as cycle().
   */
  private async quoteCycle(): Promise<void> {
    if (!this.quotes || this.quoting || this.shouldIdle()) return;
    this.quoting = true;
    try {
      const now = Date.now();
      const watch = new Set(this.engine.settings.watchlist);
      const { symbols, full } = pickQuoteSymbols({
        universe: TRACKED_UNIVERSE.map((u) => u.symbol),
        activity: (s) => this.activityOf(s),
        always: new Set([...BENCHMARK_SYMBOLS, ...watch]),
        hotCount: Math.max(0, Number(process.env.QUOTE_HOT_SYMBOLS ?? 300)),
        now,
        lastFullSweepAt: this.lastFullQuoteSweep,
        fullEveryMs: Math.max(60, Number(process.env.QUOTE_FULL_SWEEP_SEC ?? 300)) * 1000,
      });
      if (full) this.lastFullQuoteSweep = now;
      const quotes = await this.quotes.fetchAll(symbols);
      const touched = this.engine.applyQuotes(quotes);
      if (this.io && touched.length > 0) {
        this.io.emit(
          'quote-update',
          touched.map((f): QuoteTick => [f.symbol, f.livePrice ?? 0, f.livePriceChangePct, f.livePriceAt ?? 0]),
        );
      }
      if (this.quotes.lastErrors > 0) {
        console.warn(`[poller] quote sweep: ${this.quotes.lastErrors} batch(es) failed, ${quotes.length} quotes applied`);
      }
    } catch (err) {
      console.error('[poller] quote sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      this.quoting = false;
    }
  }

  private async loop(intervalMs: number): Promise<void> {
    if (this.stopped) return;
    const startedAt = Date.now();
    await this.cycle();
    if (this.stopped) return;
    this.loopTimer = setTimeout(() => void this.loop(intervalMs), Math.max(0, intervalMs - (Date.now() - startedAt)));
  }

  /** Option volume today once seen, else the last recorded day's (DB); 0 = unknown. */
  private activityOf(symbol: string): number {
    const f = this.engine.getFlow(symbol);
    const today = f && f.lastUpdated > 0 ? f.sessionPutVolume + f.sessionCallVolume : 0;
    return today > 0 ? today : (this.priorActivity.get(symbol) ?? 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.realtime?.stop();
    this.quoteTask?.stop();
    this.maintenanceTask?.stop();
    this.eodTask?.stop();
    this.edgarTask?.stop();
  }

  private async loadStoredState(): Promise<void> {
    await seedTickers();
    // Restore persisted settings so a restart keeps thresholds/watchlist.
    await tryDb('load settings', async (db) => {
      const stored = await db.userSettings.findUnique({ where: { id: 1 } });
      if (stored) {
        this.engine.settings = {
          ...this.engine.settings,
          sensitivity: stored.sensitivity,
          minPremium: stored.minPremium,
          minContracts: stored.minContracts,
          updateFrequencySec: stored.updateFrequencySec,
          soundEnabled: stored.soundEnabled,
          timezone: stored.timezone,
          hiddenColumns: stored.hiddenColumns,
          watchlist: stored.watchlist,
        };
      }
    });
    // Seed spike baselines and ratio history from the DB when available.
    await tryDb('load baselines', async (db) => {
      const baselines = await db.volumeBaseline.findMany({
        orderBy: { computedAt: 'desc' },
        distinct: ['symbol'],
      });
      for (const b of baselines) {
        const shape = Array.isArray(b.intradayShape) ? (b.intradayShape as number[]) : undefined;
        this.engine.detector.setBaseline(b.symbol, {
          avgDailyVolume: b.avgVolume,
          stdDevVolume: b.stdDevVolume,
          intradayShape: shape && shape.length === 13 ? shape : [],
          sampleDays: b.sampleDays,
        });
      }
      console.log(`[poller] loaded ${baselines.length} stored baselines`);
    });
    await tryDb('load prior activity', async (db) => {
      const rows = await db.dailyMetric.findMany({
        where: { optVolume: { not: null } },
        orderBy: [{ symbol: 'asc' }, { date: 'desc' }],
        distinct: ['symbol'],
        select: { symbol: true, optVolume: true },
      });
      for (const r of rows) if (r.optVolume) this.priorActivity.set(r.symbol, Number(r.optVolume));
    });
    await tryDb('load ratio history', async (db) => {
      const points = await db.aggregateRatioPoint.findMany({
        orderBy: { bucketStart: 'desc' },
        take: 2000,
      });
      this.engine.historicalRatios = points.map((p) => p.ratio);
    });
    // Load inverse/leverage instrument config for the interpretation layer.
    const instruments = await loadInstrumentConfigs();
    this.engine.instruments.clear();
    for (const [symbol, cfg] of instruments) this.engine.instruments.set(symbol, cfg);

    // Restore finalized sector-relative analytics so a restart keeps them.
    await loadLatestIntoEngine(this.engine);
    // What the app has learned about each name's latest signals (edge book).
    await loadConvictionsIntoEngine(this.engine);
    // How implied ranges have compared with real moves (DB-only, so it need not
    // wait for the long close-history backfill before the first maintenance pass).
    await refreshProjectionHistory(this.engine);
  }

  /**
   * Outside regular trading hours the delayed-quote feed is static, so polling
   * it re-fetches identical chains — ~81% of a 24/7 loop's calls, since the
   * session is 32.5 of every 168 hours. Idling between the close and the next
   * open is the single largest saving on a metered host (and is the polite way
   * to treat a free CDN). Maintenance, the end-of-day capture and the EDGAR
   * job run on their own schedules and are unaffected.
   *
   * The simulator keeps running so a demo works at any hour; POLL_WHEN_CLOSED=1
   * forces round-the-clock polling.
   */
  private shouldIdle(): boolean {
    if (this.engine.mode === 'simulated') return false;
    if (process.env.POLL_WHEN_CLOSED === '1') return false;
    const open = isMarketHours() && isTradingDayNow();
    if (open !== this.marketWasOpen) {
      if (this.marketWasOpen === true && !open) this.saveAtClose = true;
      this.marketWasOpen = open;
      console.log(`[poller] market ${open ? 'open — polling' : 'closed — idling until the next session'}`);
    }
    return !open;
  }

  /**
   * Restore the saved table (engine-snapshot.ts). If the market is closed and
   * rows are missing or older than the last session's close — a first start,
   * or a restart after the close with no fresh save — plan one catch-up pass:
   * the feed still serves the closing snapshot, so the evening table, the
   * ticker pages and the end-of-day capture all get the real close.
   */
  private async prepare(): Promise<void> {
    if (this.engine.mode !== 'live') return;
    await restoreEngineSnapshot(this.engine);
    if (process.env.POLL_WHEN_CLOSED === '1' || (isMarketHours() && isTradingDayNow())) return;
    const close = lastSessionClose();
    if (close === null) return;
    const stale = staleForClose(
      TRACKED_UNIVERSE.map((u) => u.symbol),
      (symbol) => this.engine.getFlow(symbol)?.dataAsOf ?? 0,
      close,
    );
    if (stale.length === 0) return;
    this.catchUp = new Set(stale);
    this.engine.catchUpRemaining = stale.length;
    console.log(
      `[poller] market closed — catching ${stale.length} names up to the ${new Date(close).toISOString()} close, then idling`,
    );
  }

  private async cycle(): Promise<void> {
    if (this.running) return; // never overlap slow cycles
    await this.ready;
    if (this.shouldIdle()) {
      if (this.catchUp && this.catchUp.size > 0) {
        await this.catchUpCycle();
        return;
      }
      if (this.saveAtClose) {
        this.saveAtClose = false;
        await saveEngineSnapshot(this.engine, 'market close');
      }
      // Keep clients connected and showing "Market closed"; skip the fetch.
      this.io?.emit('connection-status', this.engine.status());
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const updated =
        this.engine.mode === 'simulated' ? this.simulateCycle() : await this.liveCycle();

      await this.refreshMarketContext();
      await this.publish(updated);
      if (Date.now() - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
        this.lastSnapshotAt = Date.now();
        await saveEngineSnapshot(this.engine, 'routine');
      }
    } catch (err) {
      console.error('[poller] cycle failed:', err);
    } finally {
      this.running = false;
      const elapsed = Date.now() - startedAt;
      if (elapsed > 5_000) console.log(`[poller] cycle took ${elapsed}ms`);
    }
  }

  /** One batch of the after-hours catch-up; on the last, save and capture the day if it was missed. */
  private async catchUpCycle(): Promise<void> {
    const pending = this.catchUp;
    if (!pending) return;
    this.running = true;
    try {
      const updated = await this.liveCycle(pending);
      await this.refreshMarketContext();
      await this.publish(updated);
      this.engine.catchUpRemaining = pending.size;
      if (pending.size === 0) {
        this.catchUp = null;
        console.log('[poller] caught up to the last close — idling until the next session');
        await saveEngineSnapshot(this.engine, 'after-hours catch-up');
        // A restart just after the close leaves the regular capture window to an
        // empty table (the coverage guard refuses it); capture the day now.
        await maybeCaptureEndOfDay(this.engine, { late: true });
      }
    } catch (err) {
      console.error('[poller] catch-up cycle failed:', err);
    } finally {
      this.running = false;
    }
  }

  /**
   * After a batch from either loop (delayed or real-time): recompute the
   * aggregate and sector ratios, push the changed rows, persist them.
   */
  private async publish(updated: TickerFlow[]): Promise<void> {
    const { aggregate, sectors, point } = this.engine.finalizeCycle();
    if (this.io && updated.length > 0) {
      this.io.emit('flow-update', updated);
      this.io.emit('ratio-update', aggregate, sectors, point, this.engine.marketContext, this.engine.getSectorDispersions());
    }
    this.io?.emit('connection-status', this.engine.status());
    await this.persistCycle(point.time * 1000, updated);
  }

  /** VIX / VIX3M term structure: free from the CBOE index-quote endpoint. */
  private async refreshMarketContext(): Promise<void> {
    const now = Date.now();
    if (this.engine.marketContext && now - this.engine.marketContext.updatedAt < 120_000) return;
    if (this.engine.mode === 'simulated') {
      const vix = 14 + Math.random() * 8;
      const vix3m = vix + 1 + Math.random() * 2;
      this.engine.marketContext = {
        vix: Number(vix.toFixed(2)),
        vix3m: Number(vix3m.toFixed(2)),
        vixSpread: Number((vix3m - vix).toFixed(2)),
        updatedAt: now,
      };
      return;
    }
    const provider = getDataProvider();
    if (!provider || !(provider instanceof CboeClient)) return;
    const [vix, vix3m] = await Promise.all([
      provider.getIndexQuote('_VIX'),
      provider.getIndexQuote('_VIX3M'),
    ]);
    if (vix !== null || vix3m !== null) {
      this.engine.marketContext = {
        vix,
        vix3m,
        vixSpread: vix !== null && vix3m !== null ? Number((vix3m - vix).toFixed(2)) : null,
        updatedAt: now,
      };
    }
  }

  private simulateCycle(): TickerFlow[] {
    const now = Date.now();
    return TRACKED_UNIVERSE.map(({ symbol }) => {
      this.lastFetched.set(symbol, now);
      return this.engine.ingest(this.simulator.snapshot(symbol), now);
    });
  }

  /** One batch of chain refreshes; with `only`, just those names (each attempt removes it from the set). */
  private async liveCycle(only?: Set<string>): Promise<TickerFlow[]> {
    const provider = getDataProvider();
    if (!provider) return [];
    const intervalSec = Math.max(15, Number(process.env.POLL_INTERVAL_SEC ?? 30));
    // Spend at most this cycle's share of the per-minute budget, so the
    // queue never grows unboundedly on constrained plans.
    const budget = Math.max(1, Math.floor((provider.bucket.currentPerMinute * intervalSec) / 60));
    const batch = this.pickBatch(budget, only);

    const updated: TickerFlow[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const item = batch[cursor++];
        if (!item) break;
        // Stamp the ATTEMPT, success or not: a symbol that keeps failing would
        // otherwise stay "never fetched" — the most overdue name there is — and
        // be picked first on every cycle forever, wasting a slot and a token.
        this.lastFetched.set(item.symbol, Date.now());
        only?.delete(item.symbol);
        try {
          const agg = await provider.getOptionsFlowSnapshot(item.symbol, item.priority);
          updated.push(this.engine.ingest(agg));
        } catch (err) {
          console.error(`[poller] ${item.symbol} fetch failed:`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    return updated;
  }

  /**
   * Tiered schedule (refresh-schedule.ts): busy, watched and on-screen names
   * every few minutes, the quiet long tail every half hour or so, scaled to the
   * source's rate budget — so the universe can grow without every name waiting
   * a full lap.
   */
  private pickBatch(budget: number, only?: ReadonlySet<string>): { symbol: string; priority: number }[] {
    const provider = getDataProvider();
    const watch = new Set(this.engine.settings.watchlist);
    const universe = only ? TRACKED_UNIVERSE.filter(({ symbol }) => only.has(symbol)) : TRACKED_UNIVERSE;
    const candidates: RefreshCandidate[] = universe.map(({ symbol }) => {
      const flow = this.engine.getFlow(symbol);
      return {
        symbol,
        lastFetched: this.lastFetched.get(symbol) ?? 0,
        activity: this.activityOf(symbol),
        watch: watch.has(symbol),
        spiking: flow !== null && flow.spikeLevel !== 'normal',
        benchmark: BENCHMARK_SYMBOLS.has(symbol),
      };
    });
    return planRefresh(candidates, budget, provider?.bucket.currentPerMinute ?? 60, Date.now(), undefined, this.startedAt);
  }

  private async persistCycle(bucketMs: number, updated: TickerFlow[]): Promise<void> {
    if (updated.length === 0) return;
    // Round to the 5-minute bucket; upsert so repeated cycles within a bucket
    // keep the latest values. Each ticker's snapshot is filed under the bucket
    // of the market moment it reflects (dataAsOf), not when it was fetched —
    // a 15-minute-delayed chain fetched at 10:20 describes 10:05.
    const toBucket = (ms: number): Date => new Date(Math.floor(ms / 300_000) * 300_000);
    const bucketStart = toBucket(bucketMs);
    await tryDb('persist snapshots', async (db) => {
      await upsertFlowSnapshots(
        db,
        updated.slice(0, 500).map((f) => ({
          symbol: f.symbol,
          bucketStart: f.dataAsOf > 0 ? toBucket(f.dataAsOf) : bucketStart,
          putVolume: f.sessionPutVolume,
          callVolume: f.sessionCallVolume,
          putPremium: f.putPremium,
          callPremium: f.callPremium,
          putCallRatio: f.putCallRatio,
          spikeScore: f.spikeScore,
          underlying: f.underlyingPrice || null,
        })),
      );
      const agg = this.engine.getAggregate();
      if (agg) {
        await db.aggregateRatioPoint.upsert({
          where: { bucketStart },
          create: {
            bucketStart,
            ratio: agg.ratio,
            putVolume: BigInt(agg.putVolume),
            callVolume: BigInt(agg.callVolume),
          },
          update: { ratio: agg.ratio },
        });
      }
    });
  }
}
