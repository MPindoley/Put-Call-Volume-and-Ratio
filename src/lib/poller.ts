/**
 * Polling service. Every POLL_INTERVAL_SEC it refreshes as many tickers as the
 * rate budget allows, prioritizing (1) watchlist symbols, (2) tickers already
 * spiking, (3) the least-recently-updated of the rest — so on the Polygon free
 * tier (5 calls/min) the universe cycles fairly while hot names stay fresh.
 *
 * In demo mode (no POLYGON_API_KEY) the simulator refreshes every ticker every
 * cycle at zero API cost.
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { getFlowEngine, type FlowEngine } from './flow-engine';
import { getPolygonClient } from './polygon';
import { FlowSimulator } from './simulator';
import { TRACKED_UNIVERSE } from './universe';
import { tryDb, dbAvailable } from './db';
import type { ServerToClientEvents, ClientToServerEvents, TickerFlow } from '@/types';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

const CONCURRENCY = 10;

export class Poller {
  private engine: FlowEngine;
  private simulator = new FlowSimulator();
  private lastFetched = new Map<string, number>();
  private running = false;
  private task: cron.ScheduledTask | null = null;

  constructor(private io: IO | null) {
    this.engine = getFlowEngine();
  }

  start(): void {
    const intervalSec = Math.max(15, Number(process.env.POLL_INTERVAL_SEC ?? 30));
    const polygon = getPolygonClient();
    this.engine.mode = polygon.enabled ? 'live' : 'simulated';
    this.engine.dbConnected = dbAvailable();
    console.log(
      `[poller] starting: mode=${this.engine.mode}, interval=${intervalSec}s, ` +
        `universe=${TRACKED_UNIVERSE.length} tickers, rate=${polygon.bucket.perMinute}/min`,
    );

    void this.loadStoredState();
    void this.cycle(); // immediate first cycle
    this.task = cron.schedule(`*/${intervalSec} * * * * *`, () => void this.cycle());
  }

  stop(): void {
    this.task?.stop();
  }

  private async loadStoredState(): Promise<void> {
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
  }

  private async cycle(): Promise<void> {
    if (this.running) return; // never overlap slow cycles
    this.running = true;
    const startedAt = Date.now();
    try {
      const updated =
        this.engine.mode === 'simulated' ? this.simulateCycle() : await this.liveCycle();

      const { aggregate, sectors, point } = this.engine.finalizeCycle();
      if (this.io && updated.length > 0) {
        this.io.emit('flow-update', updated);
        this.io.emit('ratio-update', aggregate, sectors, point);
      }
      this.io?.emit('connection-status', {
        ...this.engine.status(),
        apiCallsLastMinute: getPolygonClient().bucket.callsLastMinute(),
      });
      await this.persistCycle(point.time * 1000, updated);
    } catch (err) {
      console.error('[poller] cycle failed:', err);
    } finally {
      this.running = false;
      const elapsed = Date.now() - startedAt;
      if (elapsed > 5_000) console.log(`[poller] cycle took ${elapsed}ms`);
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
    const polygon = getPolygonClient();
    const intervalSec = Math.max(15, Number(process.env.POLL_INTERVAL_SEC ?? 30));
    // Spend at most this cycle's share of the per-minute budget, so the
    // queue never grows unboundedly on constrained plans.
    const budget = Math.max(1, Math.floor((polygon.bucket.perMinute * intervalSec) / 60));
    const batch = this.pickBatch(budget);

    const updated: TickerFlow[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const item = batch[cursor++];
        if (!item) break;
        try {
          const agg = await polygon.getOptionsFlowSnapshot(item.symbol, item.priority);
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
