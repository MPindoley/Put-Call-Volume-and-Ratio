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
 *  runMaintenance   — the pass that runs them: intraday jobs every pass, the
 *                     whole-table daily jobs only when their inputs changed.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { SpikeAlert, TickerFlow } from '@/types';
import { getAnalyticsConfig } from './analytics-config';
import { historicalVol, ivRank } from './chain-analytics';
import { CboeClient } from './cboe';
import { getDataProvider } from './data-source';
import { tryDb } from './db';
import { finalizedMetricWhere } from './finalized-reads';
import { refreshEarningsRealized, refreshEventGauges, refreshIdiosyncraticEvents } from './event-jobs';
import { recordDailyRegime } from './regime-jobs';
import { logSignals, scoreSignals, trackBackwardationEpisodes } from './signal-jobs';
import { loadConvictionsIntoEngine, refreshEdgeBooks } from './learning-jobs';
import { gradeProjections, logProjections, refreshProjectionHistory } from './projection-jobs';
import type { FlowEngine } from './flow-engine';
import { finalizeDailyCapture, loadLatestIntoEngine } from './sector-analytics';
import { NOT_SEEDED } from './seed-guard';
import { DEFAULT_INTRADAY_SHAPE } from './spike-detector';
import { etDateKey, etTimeParts, inCaptureWindow, isTradingDayNow, pastCaptureStart } from './trading-calendar';
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
      WHERE "bucketStart" >= ${since} AT TIME ZONE 'UTC' AND "bucketStart" < ${todayStart} AT TIME ZONE 'UTC'
      GROUP BY 1, 2
    `;

    const bySymbol = new Map<string, number[]>();
    for (const row of rows) {
      const vols = bySymbol.get(row.symbol) ?? [];
      vols.push(Number(row.volume));
      bySymbol.set(row.symbol, vols);
    }

    const computed: Prisma.VolumeBaselineCreateManyInput[] = [];
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
      computed.push({
        symbol,
        avgVolume: avg,
        stdDevVolume: baseline.stdDevVolume,
        intradayShape: [...DEFAULT_INTRADAY_SHAPE],
        sampleDays: days.length,
      });
    }
    if (computed.length > 0) await db.volumeBaseline.createMany({ data: computed });
    // The loader reads only the latest row per symbol: drop the rest.
    await db.$executeRaw`
      DELETE FROM "VolumeBaseline" v
      USING (SELECT "symbol", MAX("computedAt") AS latest FROM "VolumeBaseline" GROUP BY 1) k
      WHERE v."symbol" = k."symbol" AND v."computedAt" < k.latest
    `;
    return computed.length;
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

/** Intraday snapshots are kept at full 5-minute resolution for this long, then thinned. */
export const SNAPSHOT_FULL_RES_DAYS = 5;

/**
 * Thin snapshots older than `cutoff` to the LAST one per symbol per day.
 * Snapshot volumes are cumulative, so that row carries the day's totals — all
 * that baselines (computeBaselines: MAX per day) and older history need — and
 * alert scoring only reads rows within its first few days. At ~1,400 names this
 * keeps the table to a few weeks of daily rows plus ~5 days of intraday detail
 * (~0.2M rows) instead of ~0.9M, which matters on a 0.5 GB free database.
 */
export async function downsampleSnapshots(db: PrismaClient, cutoff: Date): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "FlowSnapshot" f
    USING (
      SELECT "symbol", date_trunc('day', "bucketStart") AS day, MAX("bucketStart") AS keep
      FROM "FlowSnapshot"
      WHERE "bucketStart" < ${cutoff} AT TIME ZONE 'UTC'
      GROUP BY 1, 2
    ) k
    WHERE f."symbol" = k."symbol"
      AND date_trunc('day', f."bucketStart") = k.day
      AND f."bucketStart" < k.keep
      AND f."bucketStart" < ${cutoff} AT TIME ZONE 'UTC'
  `;
}

export interface SnapshotRow {
  symbol: string;
  bucketStart: Date;
  putVolume: number;
  callVolume: number;
  putPremium: number;
  callPremium: number;
  putCallRatio: number;
  spikeScore: number;
  underlying: number | null;
}

/**
 * Write a cycle's intraday snapshots in ONE statement, in place of a per-row
 * upsert (a read and a write each, up to 500 per cycle). A row already in its
 * 5-minute bucket takes the latest volumes, ratio and spike score and keeps its
 * first premiums and underlying, as the per-row upserts did. Times are stored
 * as UTC whatever the session's time zone.
 */
export async function upsertFlowSnapshots(db: Pick<PrismaClient, '$executeRaw'>, rows: readonly SnapshotRow[]): Promise<number> {
  // ON CONFLICT cannot touch one row twice in a statement: the last per bucket wins.
  const byKey = new Map<string, SnapshotRow>();
  for (const r of rows) byKey.set(`${r.symbol}|${r.bucketStart.getTime()}`, r);
  if (byKey.size === 0) return 0;
  const values = [...byKey.values()].map(
    (r) => Prisma.sql`(
      ${r.symbol}, ${r.bucketStart} AT TIME ZONE 'UTC',
      CAST(${r.putVolume} AS integer), CAST(${r.callVolume} AS integer),
      CAST(${r.putPremium} AS double precision), CAST(${r.callPremium} AS double precision),
      CAST(${r.putCallRatio} AS double precision), CAST(${r.spikeScore} AS integer),
      CAST(${r.underlying} AS double precision)
    )`,
  );
  return db.$executeRaw`
    INSERT INTO "FlowSnapshot"
      ("symbol", "bucketStart", "putVolume", "callVolume", "putPremium", "callPremium", "putCallRatio", "spikeScore", "underlying")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("symbol", "bucketStart") DO UPDATE SET
      "putVolume" = EXCLUDED."putVolume",
      "callVolume" = EXCLUDED."callVolume",
      "putCallRatio" = EXCLUDED."putCallRatio",
      "spikeScore" = EXCLUDED."spikeScore"
  `;
}

export async function pruneHistory(): Promise<void> {
  await tryDb('prune history', async (db) => {
    await db.flowSnapshot.deleteMany({ where: { bucketStart: { lt: new Date(Date.now() - 35 * DAY_MS) } } });
    const thinned = await downsampleSnapshots(db, new Date(Date.now() - SNAPSHOT_FULL_RES_DAYS * DAY_MS));
    if (thinned > 0) console.log(`[maintenance] thinned ${thinned} intraday snapshots older than ${SNAPSHOT_FULL_RES_DAYS} days`);
    await db.aggregateRatioPoint.deleteMany({ where: { bucketStart: { lt: new Date(Date.now() - 90 * DAY_MS) } } });
    // Same horizon as DailyMetric (recordDailyMetrics): a relative-metric row with
    // no close left to pair it with feeds nothing, and unbounded growth at ~1,400
    // names would add ~140 MB a year.
    await db.relativeMetric.deleteMany({ where: { date: { lt: new Date(Date.now() - 400 * DAY_MS) } } });
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
      (await db.dailyMetric.findMany({ where: finalizedMetricWhere({ date: today }), select: { symbol: true } })).map(
        (r) => r.symbol,
      ),
    );
    for (const flow of engine.allFlows()) {
      if (flow.lastUpdated === 0 || finalizedToday.has(flow.symbol)) continue;
      // Only rows holding today's session: a row restored from an earlier
      // session's saved table must not be filed under today's date.
      if (etDateKey(new Date(flow.dataAsOf)).getTime() !== today.getTime()) continue;
      const optVolume = flow.sessionPutVolume + flow.sessionCallVolume;
      const data = {
        iv30: flow.iv30,
        hv20: flow.hv20,
        // Provisional rows NEVER carry `close` — the intraday price goes to
        // `liveClose` so no close-based statistic can ever read an unsettled value.
        // `close` is set only by finalizeDailyCapture / backfill (both final=true).
        close: null,
        liveClose: flow.underlyingPrice > 0 ? flow.underlyingPrice : null,
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

const closeBackfillTried = new Set<string>();

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
    // A name tried once this process (e.g. listed too recently for 60 sessions) is not re-fetched every pass.
    const targets = TRACKED_UNIVERSE.filter(
      ({ symbol }) => (have.get(symbol) ?? 0) < 60 && !closeBackfillTried.has(symbol),
    ).slice(0, budget);
    for (const { symbol } of targets) closeBackfillTried.add(symbol);

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
 * Share of the universe that must hold data from today's session before the
 * day is pinned. The capture reads the in-memory table; right after a restart
 * that table can be empty or half-filled, and pinning it would make the day's
 * history permanently partial (a finalized row is never re-captured).
 */
export const MIN_CAPTURE_COVERAGE = 0.5;

/** How many rows carry data from the given ET session. */
export function sessionCoverage(flows: readonly TickerFlow[], day: Date): number {
  const key = day.getTime();
  return flows.filter((f) => f.dataAsOf > 0 && etDateKey(new Date(f.dataAsOf)).getTime() === key).length;
}

/**
 * Fire the pinned end-of-day capture once per session, gated on the trading
 * calendar and the post-close ET window. Idempotent: a second call after
 * today is already finalized is a cheap no-op.
 *
 * `late`: an after-hours catch-up pass (poller.ts) just refilled the table
 * with the session's closing data, so capture now if the regular window was
 * missed — same ET date only. The values are the same the window would have
 * seen: after the close the feed's snapshot no longer changes.
 */
let capturing = false;

export async function maybeCaptureEndOfDay(
  engine: FlowEngine,
  opts: { now?: Date; late?: boolean } = {},
): Promise<boolean> {
  // The scheduled check and a catch-up's late capture can coincide: one at a time.
  if (capturing) return false;
  capturing = true;
  try {
    return await captureEndOfDay(engine, opts);
  } finally {
    capturing = false;
  }
}

async function captureEndOfDay(engine: FlowEngine, opts: { now?: Date; late?: boolean }): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (engine.mode !== 'simulated' && !isTradingDayNow(now)) return false;
  const config = await getAnalyticsConfig();
  const inWindow = inCaptureWindow(now, config.captureDelayMin, config.captureWindowMin);
  const late = opts.late === true && pastCaptureStart(now, config.captureDelayMin);
  if (!inWindow && !late) return false;

  const today = etDateKey(now);
  const alreadyFinal = await tryDb('check finalized', (db) =>
    db.dailyMetric.findFirst({ where: { date: today, final: true, historicalCloseOnly: false } }),
  );
  if (alreadyFinal) return false;

  if (engine.mode !== 'simulated') {
    const covered = sessionCoverage(engine.allFlows(), today);
    const needed = Math.ceil(TRACKED_UNIVERSE.length * MIN_CAPTURE_COVERAGE);
    if (covered < needed) {
      console.warn(
        `[eod] only ${covered}/${TRACKED_UNIVERSE.length} names hold today's data — not pinning a partial day ` +
          '(the after-hours catch-up captures once the table is refilled)',
      );
      return false;
    }
  }

  console.log(`[eod] capturing pinned end-of-day snapshot${late && !inWindow ? ' (late: after a catch-up pass)' : ''}…`);
  const ok = await finalizeDailyCapture(engine, now);
  if (ok) {
    // Regime state depends on the finalized SPY close + per-ticker GEX just written;
    // signals fire only once the regime row is final (never on provisional data).
    await recordDailyRegime(engine, now);
    const emitted = await logSignals(engine, now);
    await trackBackwardationEpisodes(now);
    if (emitted > 0) console.log(`[signals] logged ${emitted} signals for today's session`);
    // Weekly: today's implied ranges, to be graded at their expiries.
    await logProjections(engine, now);
  }
  return ok;
}

interface VolHistoryRow {
  symbol: string;
  date: Date;
  iv30: number | null;
  hv20: number | null;
  putOI: number | null;
  callOI: number | null;
  rrSkew: number | null;
}

/** The year of finalized history IV rank reads, kept until the daily inputs change. */
let volHistory: { key: string; bySymbol: Map<string, VolHistoryRow[]> } | null = null;

/**
 * Refresh per-ticker vol context: IV rank from stored IV30 history, HV20 from
 * CBOE daily closes (fetched for up to `hvBudget` tickers per pass, so the
 * whole universe backfills within the first day), and yesterday's OI totals.
 * IV rank follows today's live IV on every pass; the stored history it ranks
 * against is re-read only when `historyKey` (dailyInputsKey) changes.
 */
export async function refreshVolContext(engine: FlowEngine, historyKey: string | null = null, hvBudget = 60): Promise<void> {
  await tryDb('refresh vol context', async (db) => {
    let bySymbol = historyKey !== null && volHistory?.key === historyKey ? volHistory.bySymbol : null;
    if (!bySymbol) {
      const since = new Date(Date.now() - 370 * DAY_MS);
      const rows: VolHistoryRow[] = await db.dailyMetric.findMany({
        where: finalizedMetricWhere({ date: { gte: since } }), // finalized rows only — IV-rank history + OI tiebreaker never read a provisional value (L2-2)
        orderBy: { date: 'asc' },
        select: { symbol: true, date: true, iv30: true, hv20: true, putOI: true, callOI: true, rrSkew: true },
      });
      bySymbol = new Map<string, VolHistoryRow[]>();
      for (const row of rows) {
        const list = bySymbol.get(row.symbol) ?? [];
        list.push(row);
        bySymbol.set(row.symbol, list);
      }
      volHistory = historyKey !== null ? { key: historyKey, bySymbol } : null;
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

/**
 * Changes when what the daily jobs read changes: a new ET day, or finalized
 * rows added (the end-of-day capture, a close backfill). Null without a database.
 */
async function dailyInputsKey(): Promise<string | null> {
  return tryDb('daily inputs key', async (db) => {
    const agg = await db.dailyMetric.aggregate({ where: { final: true }, _max: { date: true }, _count: { _all: true } });
    return `${etDateKey().toISOString().slice(0, 10)}|${agg._max.date?.toISOString() ?? 'none'}|${agg._count._all}`;
  });
}

/** dailyInputsKey as of the last pass that ran the daily jobs. */
let lastDailyKey: string | null = null;
let maintaining = false;

/**
 * True when a scheduled pass can find new work: trading days, 9:00–21:00 ET
 * (the session, the end-of-day capture and the evening grading after it).
 * Outside that window nothing the jobs read changes, and an idle database —
 * one that scales to zero, or meters its hours — is left alone.
 */
export function maintenanceWindow(now = new Date()): boolean {
  if (!isTradingDayNow(now)) return false;
  const { minutesOfDay } = etTimeParts(now);
  return minutesOfDay >= 9 * 60 && minutesOfDay < 21 * 60;
}

/**
 * One maintenance pass; at startup and every 2h in maintenanceWindow. The
 * intraday jobs run every pass; the daily ones (baselines, event detection,
 * signal and projection grading, the edge book, retention) re-read whole
 * tables, so they run only when dailyInputsKey has changed — about twice a
 * trading day instead of every pass.
 */
export async function runMaintenance(engine: FlowEngine): Promise<void> {
  if (maintaining) return; // a slow pass (e.g. filling a new database) never overlaps the next
  maintaining = true;
  try {
    await backfillCloseHistory(engine);
    const key = await dailyInputsKey();
    const daily = key === null || key !== lastDailyKey;
    const baselines = daily ? await computeBaselines(engine) : 0;
    const scored = await scoreAlerts();
    await recordDailyMetrics(engine);
    await refreshVolContext(engine, key);
    // Phase 3: detect idiosyncratic moves (SPY-residual feed), fill realized moves
    // for confirmed calendar events, then reload the per-ticker event-gauge inputs.
    const idio = daily ? await refreshIdiosyncraticEvents() : 0;
    const realized = daily ? await refreshEarningsRealized() : 0;
    await refreshEventGauges(engine);
    if (daily) {
      // Phase 4.3: fill forward returns for signals whose 20-trading-day window elapsed.
      const sigScored = await scoreSignals();
      if (sigScored > 0) console.log(`[signals] scored ${sigScored} signals (20-td window elapsed)`);
      // Learning loop: write tonight's edge book from the just-graded evidence
      // (and reconstruct any missing past books under the current version).
      const books = await refreshEdgeBooks();
      if (books && books.written > 0) await loadConvictionsIntoEngine(engine);
      // Projections: grade the ones whose expiry settled.
      await gradeProjections();
    }
    // How implied ranges have compared with real moves (skips when nothing new was finalized).
    await refreshProjectionHistory(engine);
    if (daily) await pruneHistory();
    if (key !== null) lastDailyKey = key;
    if (baselines > 0 || scored > 0 || idio > 0 || realized > 0) {
      console.log(
        `[maintenance] baselines refreshed for ${baselines} tickers, ${scored} alerts scored, ` +
          `${idio} idiosyncratic moves, ${realized} realized earnings moves`,
      );
    }
  } finally {
    maintaining = false;
  }
}
