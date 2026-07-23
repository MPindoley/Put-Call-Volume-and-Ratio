/**
 * Maintenance jobs that turn stored snapshots into intelligence. All of them
 * are DB-dependent and silently no-op when no database is configured.
 *
 *  seedTickers      — upsert the universe into Ticker so snapshot/alert rows
 *                     satisfy their foreign keys (run once at startup).
 *  persistAlert     — write each fired alert to the Alert table for auditing
 *                     and later accuracy scoring.
 *  computeBaselines — roll stored 5-min snapshots into per-ticker 20-day
 *                     average daily volume + stddev; feeds the spike detector
 *                     so "N× expected" is measured against real history.
 *  scoreAlerts      — fill Alert.moveNextDay: underlying % move ~1 trading
 *                     day after each alert. Powers the accuracy scoreboard.
 *  pruneHistory     — retention: snapshots 35d, ratio points 90d, alerts 120d.
 */
import type { SpikeAlert } from '@/types';
import { getAnalyticsConfig } from './analytics-config';
import { historicalVol, ivRank } from './chain-analytics';
import { CboeClient } from './cboe';
import { getDataProvider } from './data-source';
import { tryDb } from './db';
import { refreshEarningsRealized, refreshEventGauges, refreshIdiosyncraticEvents } from './event-jobs';
import { recordDailyRegime } from './regime-jobs';
import { logSignals, scoreSignals, trackBackwardationEpisodes } from './signal-jobs';
import type { FlowEngine } from './flow-engine';
import { finalizeDailyCapture, loadLatestIntoEngine } from './sector-analytics';
import { NOT_SEEDED } from './seed-guard';
import { DEFAULT_INTRADAY_SHAPE } from './spike-detector';
import { etDateKey, inCaptureWindow, isTradingDayNow } from './trading-calendar';
import { TRACKED_UNIVERSE } from './universe';

const DAY_MS = 86_400_000;

export async function seedTickers(): Promise<void> {
  await tryDb('seed tickers', async (db) => {
    await db.ticker.createMany({
      data: TRACKED_UNIVERSE.map(({ symbol, sector }) => ({ symbol, sector })),
      skipDuplicates: true,
    });
  });
}

export async function persistAlert(alert: SpikeAlert): Promise<void> {
  await tryDb('persist alert', (db) =>
    db.alert.create({
      data: {
        id: alert.id,
        symbol: alert.symbol,
        level: alert.level,
        message: alert.message,
        volumeMultiple: alert.volumeMultiple,
        premium: alert.premium,
        contracts: alert.contracts,
        putCallRatio: alert.putCallRatio,
        createdAt: new Date(alert.createdAt),
      },
    }),
  );
}

interface DailyVolumeRow {
  symbol: string;
  day: Date;
  volume: bigint | number;
}

/** 20-day baselines from stored snapshots (session volumes are cumulative, so MAX per day = day total). */
export async function computeBaselines(engine: FlowEngine): Promise<number> {
  const updated = await tryDb('compute baselines', async (db) => {
    const since = new Date(Date.now() - 30 * DAY_MS);
    // ET day boundary (matches every other date cutoff), not UTC.
    const todayStart = etDateKey();
    const rows = await db.$queryRaw<DailyVolumeRow[]>`
      SELECT "symbol",
             date_trunc('day', "bucketStart") AS day,
             MAX("putVolume" + "callVolume") AS volume
      FROM "FlowSnapshot"
      WHERE "bucketStart" >= ${since} AND "bucketStart" < ${todayStart}
      GROUP BY 1, 2
    `;

    const bySymbol = new Map<string, number[]>();
    for (const row of rows) {
      const vols = bySymbol.get(row.symbol) ?? [];
      vols.push(Number(row.volume));
      bySymbol.set(row.symbol, vols);
    }

    let count = 0;
    for (const [symbol, vols] of bySymbol) {
      const days = vols.slice(-20);
      if (days.length < 3) continue; // not enough history to be meaningful
      const avg = days.reduce((a, b) => a + b, 0) / days.length;
      const variance = days.reduce((a, b) => a + (b - avg) ** 2, 0) / days.length;
      const baseline = {
        avgDailyVolume: avg,
        stdDevVolume: Math.sqrt(variance),
        intradayShape: DEFAULT_INTRADAY_SHAPE,
        sampleDays: days.length,
      };
      engine.detector.setBaseline(symbol, baseline);
      await db.volumeBaseline.create({
        data: {
          symbol,
          avgVolume: avg,
          stdDevVolume: baseline.stdDevVolume,
          intradayShape: [...DEFAULT_INTRADAY_SHAPE],
          sampleDays: days.length,
        },
      });
      count += 1;
    }
    // Keep only recent baseline rows; the loader takes the latest per symbol.
    await db.volumeBaseline.deleteMany({ where: { computedAt: { lt: new Date(Date.now() - 45 * DAY_MS) } } });
    return count;
  });
  return updated ?? 0;
}

/** Fill moveNextDay for alerts at least ~1 trading day old. */
export async function scoreAlerts(): Promise<number> {
  const scored = await tryDb('score alerts', async (db) => {
    const cutoff = new Date(Date.now() - 20 * 3_600_000);
    const pending = await db.alert.findMany({
      where: { moveNextDay: null, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    let count = 0;
    for (const alert of pending) {
      const atAlert = await db.flowSnapshot.findFirst({
        where: { symbol: alert.symbol, bucketStart: { lte: alert.createdAt }, underlying: { not: null } },
        orderBy: { bucketStart: 'desc' },
      });
      const after = await db.flowSnapshot.findFirst({
        where: {
          symbol: alert.symbol,
          bucketStart: { gte: new Date(alert.createdAt.getTime() + 20 * 3_600_000) },
          underlying: { not: null },
        },
        orderBy: { bucketStart: 'asc' },
      });
      if (!atAlert?.underlying || !after?.underlying) {
        // If 3+ days passed and we still can't price it, mark unmeasurable (0).
        if (Date.now() - alert.createdAt.getTime() > 3 * DAY_MS) {
          await db.alert.update({ where: { id: alert.id }, data: { moveNextDay: 0 } });
        }
        continue;
      }
      const move = (after.underlying / atAlert.underlying - 1) * 100;
      await db.alert.update({ where: { id: alert.id }, data: { moveNextDay: Number(move.toFixed(3)) } });
      count += 1;
    }
    return count;
  });
  return scored ?? 0;
}

export async function pruneHistory(): Promise<void> {
  await tryDb('prune history', async (db) => {
    await db.flowSnapshot.deleteMany({ where: { bucketStart: { lt: new Date(Date.now() - 35 * DAY_MS) } } });
    await db.aggregateRatioPoint.deleteMany({ where: { bucketStart: { lt: new Date(Date.now() - 90 * DAY_MS) } } });
    await db.alert.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 120 * DAY_MS) } } });
  });
}

/**
 * Write PROVISIONAL (final=false) daily metric rows from live state, used for
 * intraday context. Never overwrites a finalized (pinned EOD) row or a
 * historical-close-only backfill row — those are authoritative.
 */
export async function recordDailyMetrics(engine: FlowEngine): Promise<void> {
  await tryDb('record daily metrics', async (db) => {
    const today = etDateKey();
    const finalizedToday = new Set(
      (await db.dailyMetric.findMany({ where: { date: today, final: true, ...NOT_SEEDED }, select: { symbol: true } })).map(
        (r) => r.symbol,
      ),
    );
    for (const flow of engine.allFlows()) {
      if (flow.lastUpdated === 0 || finalizedToday.has(flow.symbol)) continue;
      const optVolume = flow.sessionPutVolume + flow.sessionCallVolume;
      const data = {
        iv30: flow.iv30,
        hv20: flow.hv20,
        close: flow.underlyingPrice > 0 ? flow.underlyingPrice : null,
        putOI: flow.analytics ? flow.analytics.putOI : null,
        callOI: flow.analytics ? flow.analytics.callOI : null,
        rrSkew: flow.analytics?.rrSkew25 ?? null,
        optVolume: optVolume > 0 ? optVolume : null,
        final: false,
        historicalCloseOnly: false,
      };
      await db.dailyMetric.upsert({
        where: { symbol_date: { symbol: flow.symbol, date: today } },
        create: { symbol: flow.symbol, date: today, ...data },
        update: data,
      });
    }
    await db.dailyMetric.deleteMany({ where: { date: { lt: new Date(Date.now() - 400 * DAY_MS) } } });
  });
}

/**
 * Backfill DailyMetric.close from CBOE's 20-year daily history so HV, the
 * 20-day price trend and price-derived sector relatives are real from day one.
 * Backfilled rows are marked `historicalCloseOnly` (close present, IV/skew/OI
 * null) and NEVER overwrite today's live/provisional row or any existing row
 * that already carries IV data.
 */
export async function backfillCloseHistory(engine: FlowEngine, budget = 80): Promise<number> {
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) return 0;
  const today = etDateKey().getTime();

  const filled = await tryDb('backfill close history', async (db) => {
    // Only backfill tickers that don't yet have a meaningful close history.
    const counts = await db.dailyMetric.groupBy({
      by: ['symbol'],
      where: { close: { not: null }, ...NOT_SEEDED },
      _count: { _all: true },
    });
    const have = new Map(counts.map((c) => [c.symbol, c._count._all]));
    const targets = TRACKED_UNIVERSE.filter(({ symbol }) => (have.get(symbol) ?? 0) < 60).slice(0, budget);

    let done = 0;
    for (const { symbol } of targets) {
      try {
        const closes = await provider.getDailyClosesDated(symbol, 120);
        if (closes.length === 0) continue;
        // Existing dates we must not clobber (live/provisional or IV-bearing).
        const existing = new Set(
          (
            await db.dailyMetric.findMany({ where: { symbol }, select: { date: true } })
          ).map((r) => r.date.getTime()),
        );
        const toInsert = closes
          .filter((c) => c.date.getTime() < today && !existing.has(c.date.getTime()))
          .map((c) => ({ symbol, date: c.date, close: c.close, final: true, historicalCloseOnly: true }));
        if (toInsert.length > 0) {
          await db.dailyMetric.createMany({ data: toInsert, skipDuplicates: true });
          done += 1;
        }
      } catch (err) {
        console.warn(`[backfill] close history failed for ${symbol}:`, err instanceof Error ? err.message : err);
      }
    }
    return done;
  });
  if ((filled ?? 0) > 0) console.log(`[backfill] close history filled for ${filled} tickers`);
  return filled ?? 0;
}

/**
 * Fire the pinned end-of-day capture once per session, gated on the trading
 * calendar and the post-close ET window. Idempotent: a second call after
 * today is already finalized is a cheap no-op.
 */
export async function maybeCaptureEndOfDay(engine: FlowEngine): Promise<boolean> {
  if (engine.mode !== 'simulated' && !isTradingDayNow()) return false;
  const config = await getAnalyticsConfig();
  if (!inCaptureWindow(new Date(), config.captureDelayMin, config.captureWindowMin)) return false;

  const today = etDateKey();
  const alreadyFinal = await tryDb('check finalized', (db) =>
    db.dailyMetric.findFirst({ where: { date: today, final: true, historicalCloseOnly: false } }),
  );
  if (alreadyFinal) return false;

  console.log('[eod] capturing pinned end-of-day snapshot…');
  const ok = await finalizeDailyCapture(engine);
  if (ok) {
    // Regime state depends on the finalized SPY close + per-ticker GEX just written;
    // signals fire only once the regime row is final (never on provisional data).
    await recordDailyRegime(engine);
    const emitted = await logSignals(engine);
    await trackBackwardationEpisodes();
    if (emitted > 0) console.log(`[signals] logged ${emitted} signals for today's session`);
  }
  return ok;
}

/**
 * Refresh per-ticker vol context: IV rank from stored IV30 history, HV20 from
 * CBOE daily closes (fetched for up to `hvBudget` tickers per pass, so the
 * whole universe backfills within the first day), and yesterday's OI totals.
 */
export async function refreshVolContext(engine: FlowEngine, hvBudget = 60): Promise<void> {
  await tryDb('refresh vol context', async (db) => {
    const since = new Date(Date.now() - 370 * DAY_MS);
    const rows = await db.dailyMetric.findMany({
      where: { date: { gte: since }, ...NOT_SEEDED },
      orderBy: { date: 'asc' },
      select: { symbol: true, date: true, iv30: true, hv20: true, putOI: true, callOI: true, rrSkew: true },
    });
    const bySymbol = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySymbol.get(row.symbol) ?? [];
      list.push(row);
      bySymbol.set(row.symbol, list);
    }

    // Use the ET capture date (matching finalize/recordDailyMetrics), so that
    // late-evening UTC never treats today's finalized row as "prev" (which would
    // zero out day-over-day OI change and the OI tiebreaker).
    const today = etDateKey().toISOString().slice(0, 10);
    for (const { symbol } of TRACKED_UNIVERSE) {
      const history = bySymbol.get(symbol) ?? [];
      const ivHistory = history.map((h) => h.iv30 ?? 0).filter((v) => v > 0);
      const currentIv = engine.getFlow(symbol)?.iv30 ?? 0;
      const prev = [...history].reverse().find((h) => h.date.toISOString().slice(0, 10) !== today);
      const latestHv = [...history].reverse().find((h) => h.hv20 !== null)?.hv20 ?? null;
      const existing = engine.volContext.get(symbol);
      engine.volContext.set(symbol, {
        ivRank: currentIv > 0 ? ivRank(currentIv, ivHistory) : null,
        hv20: latestHv ?? existing?.hv20 ?? null,
        prevTotalOI: prev && prev.putOI !== null && prev.callOI !== null ? prev.putOI + prev.callOI : null,
        prevPutOI: prev?.putOI ?? null,
        prevCallOI: prev?.callOI ?? null,
        prevRrSkew: prev?.rrSkew ?? null,
      });
    }

  });
  await backfillHV(engine, hvBudget);
}

/**
 * HV20 backfill from CBOE's free daily-history endpoint. Deliberately NOT
 * DB-gated: realized vol works day one without a database (results are then
 * persisted best-effort when one is connected).
 */
async function backfillHV(engine: FlowEngine, hvBudget: number): Promise<void> {
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) return;
  const missing = TRACKED_UNIVERSE.filter((u) => {
    const ctx = engine.volContext.get(u.symbol);
    return !ctx || ctx.hv20 === null;
  }).slice(0, hvBudget);
  let filled = 0;
  for (const { symbol } of missing) {
    try {
      const closes = await provider.getDailyCloses(symbol);
      const hv = historicalVol(closes);
      if (hv !== null) {
        const ctx = engine.volContext.get(symbol) ?? { ivRank: null, hv20: null, prevTotalOI: null, prevPutOI: null, prevCallOI: null, prevRrSkew: null };
        ctx.hv20 = hv;
        engine.volContext.set(symbol, ctx);
        const day = new Date(new Date().toISOString().slice(0, 10));
        await tryDb('persist hv', (db) =>
          db.dailyMetric.upsert({
            where: { symbol_date: { symbol, date: day } },
            create: { symbol, date: day, hv20: hv },
            update: { hv20: hv },
          }),
        );
        filled += 1;
      }
    } catch (err) {
      console.warn(`[maintenance] HV fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  if (filled > 0) console.log(`[maintenance] HV20 computed for ${filled} tickers`);
}

/** One maintenance pass; scheduled every 2h and at startup. */
export async function runMaintenance(engine: FlowEngine): Promise<void> {
  const baselines = await computeBaselines(engine);
  const scored = await scoreAlerts();
  await recordDailyMetrics(engine);
  await refreshVolContext(engine);
  // Phase 3: detect idiosyncratic moves (SPY-residual feed), fill realized moves
  // for confirmed calendar events, then reload the per-ticker event-gauge inputs.
  const idio = await refreshIdiosyncraticEvents();
  const realized = await refreshEarningsRealized();
  await refreshEventGauges(engine);
  // Phase 4.3: fill forward returns for signals whose 20-trading-day window elapsed.
  const sigScored = await scoreSignals();
  if (sigScored > 0) console.log(`[signals] scored ${sigScored} signals (20-td window elapsed)`);
  await pruneHistory();
  if (baselines > 0 || scored > 0 || idio > 0 || realized > 0) {
    console.log(
      `[maintenance] baselines refreshed for ${baselines} tickers, ${scored} alerts scored, ` +
        `${idio} idiosyncratic moves, ${realized} realized earnings moves`,
    );
  }
}
