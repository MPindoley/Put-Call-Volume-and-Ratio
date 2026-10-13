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
  maybeCaptureEndOfDay,
  persistAlert,
  runMaintenance,
  seedTickers,
} from './history-jobs';
import { loadInstrumentConfigs } from './interpretation';
import { backfillRegimeHistory } from './regime-jobs';
import { loadConvictionsIntoEngine } from './learning-jobs';
import { loadLatestIntoEngine } from './sector-analytics';
import { getQuoteClient, type QuoteClient } from './quotes';
import { FlowSimulator } from './simulator';
import { isTradingDayNow } from './trading-calendar';
import { TRACKED_UNIVERSE } from './universe';
import { isMarketHours } from './utils';
import { tryDb, dbAvailable } from './db';
import type { ServerToClientEvents, ClientToServerEvents, TickerFlow } from '@/types';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

const CONCURRENCY = 10;

export class Poller {
  private engine: FlowEngine;
  private simulator = new FlowSimulator();
  private lastFetched = new Map<string, number>();
  private running = false;
  private quoting = false;
  private quotes: QuoteClient | null = getQuoteClient();
  private quoteTask: cron.ScheduledTask | null = null;
  private marketWasOpen: boolean | null = null;
  private task: cron.ScheduledTask | null = null;
  private maintenanceTask: cron.ScheduledTask | null = null;
  private eodTask: cron.ScheduledTask | null = null;
  private edgarTask: cron.ScheduledTask | null = null;

  constructor(private io: IO | null) {
    this.engine = getFlowEngine();
  }

  start(): void {
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
    setTimeout(() => void this.cycle(), warmupMs).unref();
    this.task = cron.schedule(`*/${intervalSec} * * * * *`, () => void this.cycle());

    // Live-quote sweep on its own, much faster cadence. It covers the WHOLE
    // universe every pass (~28 batched requests, ~580 KB) instead of rotating,
    // so price freshness is independent of the ~9-minute chain rotation.
    if (this.quotes) {
      const quoteSec = Math.max(15, Number(process.env.QUOTE_INTERVAL_SEC ?? 60));
      console.log(`[poller] live quotes: ${this.quotes.name}, every ${quoteSec}s, ${TRACKED_UNIVERSE.length} symbols`);
      // Staggered after the chain warmup so the two sweeps do not both land
      // on top of the healthcheck window.
      setTimeout(() => void this.quoteCycle(), warmupMs + 2_000).unref();
      this.quoteTask = cron.schedule(`*/${quoteSec} * * * * *`, () => void this.quoteCycle());
    }
    // Baselines, alert scoring, provisional metrics and retention: every 2 hours.
    this.maintenanceTask = cron.schedule('11 */2 * * *', () => void runMaintenance(this.engine));
    // Pinned end-of-day capture: checked every 5 min; fires once in the
    // post-close ET window (self-gated on the trading calendar).
    this.eodTask = cron.schedule('*/5 * * * *', () => void maybeCaptureEndOfDay(this.engine));
    // SEC EDGAR earnings confirmation for the configured priority list: once daily
    // (cached + throttled; no-ops when no tickers are configured).
    this.edgarTask = cron.schedule('23 5 * * *', () => void refreshEdgarConfirmations());
  }

  /**
   * Sweep live underlying prices for the whole universe and push the deltas.
   * Deliberately independent of cycle(): it must not wait on the chain
   * rotation, and a quote failure must not disturb chain polling (or vice
   * versa). Idles outside trading hours on the same rule as cycle().
   */
  private async quoteCycle(): Promise<void> {
    if (!this.quotes || this.quoting || this.shouldIdle()) return;
    this.quoting = true;
    try {
      const quotes = await this.quotes.fetchAll(TRACKED_UNIVERSE.map((u) => u.symbol));
      const touched = this.engine.applyQuotes(quotes);
      if (this.io && touched.length > 0) this.io.emit('flow-update', touched);
      if (this.quotes.lastErrors > 0) {
        console.warn(`[poller] quote sweep: ${this.quotes.lastErrors} batch(es) failed, ${quotes.length} quotes applied`);
      }
    } catch (err) {
      console.error('[poller] quote sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      this.quoting = false;
    }
  }

  stop(): void {
    this.task?.stop();
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
      this.marketWasOpen = open;
      console.log(`[poller] market ${open ? 'open — polling' : 'closed — idling until the next session'}`);
    }
    return !open;
  }

  private async cycle(): Promise<void> {
    if (this.running) return; // never overlap slow cycles
    if (this.shouldIdle()) {
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
      const { aggregate, sectors, point } = this.engine.finalizeCycle();
      if (this.io && updated.length > 0) {
        this.io.emit('flow-update', updated);
        this.io.emit('ratio-update', aggregate, sectors, point, this.engine.marketContext, this.engine.getSectorDispersions());
      }
      this.io?.emit('connection-status', this.engine.status());
      await this.persistCycle(point.time * 1000, updated);
    } catch (err) {
      console.error('[poller] cycle failed:', err);
    } finally {
      this.running = false;
      const elapsed = Date.now() - startedAt;
      if (elapsed > 5_000) console.log(`[poller] cycle took ${elapsed}ms`);
    }
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

  private async liveCycle(): Promise<TickerFlow[]> {
    const provider = getDataProvider();
    if (!provider) return [];
    const intervalSec = Math.max(15, Number(process.env.POLL_INTERVAL_SEC ?? 30));
    // Spend at most this cycle's share of the per-minute budget, so the
    // queue never grows unboundedly on constrained plans.
    const budget = Math.max(1, Math.floor((provider.bucket.perMinute * intervalSec) / 60));
    const batch = this.pickBatch(budget);

    const updated: TickerFlow[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const item = batch[cursor++];
        if (!item) break;
        try {
          const agg = await provider.getOptionsFlowSnapshot(item.symbol, item.priority);
          this.lastFetched.set(item.symbol, Date.now());
          updated.push(this.engine.ingest(agg));
        } catch (err) {
          console.error(`[poller] ${item.symbol} fetch failed:`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    return updated;
  }

  /** Priority order: watchlist → currently spiking → stalest first. */
  private pickBatch(budget: number): { symbol: string; priority: number }[] {
    const watch = new Set(this.engine.settings.watchlist);
    const scored = TRACKED_UNIVERSE.map(({ symbol }) => {
      const flow = this.engine.getFlow(symbol);
      const spiking = flow !== null && flow.spikeLevel !== 'normal';
      const priority = watch.has(symbol) ? 1 : spiking ? 2 : 5;
      return { symbol, priority, staleness: this.lastFetched.get(symbol) ?? 0 };
    });
    scored.sort((a, b) => a.priority - b.priority || a.staleness - b.staleness);
    return scored.slice(0, budget).map(({ symbol, priority }) => ({ symbol, priority }));
  }

  private async persistCycle(bucketMs: number, updated: TickerFlow[]): Promise<void> {
    if (updated.length === 0) return;
    // Round to the 5-minute bucket; upsert so repeated cycles within a bucket
    // keep the latest values.
    const bucketStart = new Date(Math.floor(bucketMs / 300_000) * 300_000);
    await tryDb('persist snapshots', async (db) => {
      await db.$transaction(
        updated.slice(0, 500).map((f) =>
          db.flowSnapshot.upsert({
            where: { symbol_bucketStart: { symbol: f.symbol, bucketStart } },
            create: {
              symbol: f.symbol,
              bucketStart,
              putVolume: f.sessionPutVolume,
              callVolume: f.sessionCallVolume,
              putPremium: f.putPremium,
              callPremium: f.callPremium,
              putCallRatio: f.putCallRatio,
              spikeScore: f.spikeScore,
              underlying: f.underlyingPrice || null,
            },
            update: {
              putVolume: f.sessionPutVolume,
              callVolume: f.sessionCallVolume,
              putCallRatio: f.putCallRatio,
              spikeScore: f.spikeScore,
            },
          }),
        ),
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
