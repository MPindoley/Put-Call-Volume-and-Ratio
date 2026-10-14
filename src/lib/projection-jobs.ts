/**
 * Projection history jobs (projection.ts, projection-history.ts):
 *
 *  logProjections            — at the pinned end-of-day capture, once per ET week:
 *                              each name's ~7- and ~30-day implied ranges.
 *  gradeProjections          — fill each logged projection's outcome (the settled
 *                              close at expiry) once that session is finalized.
 *  refreshProjectionHistory  — nightly: realized-vs-implied calibration per name
 *                              and sector, and graded-projection coverage, into
 *                              the engine.
 *
 * Only finalized, non-seeded DailyMetric rows are read (invariant 2), so a
 * provisional intraday price never grades or calibrates anything.
 */
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import { PROJECTION_METHOD_VERSION, type ExpiryProjection } from './projection';
import {
  calibrationStats,
  calibrationView,
  coverage,
  HORIZONS,
  standardizedMoves,
  type CalibrationView,
  type Coverage,
  type DayPoint,
  type HorizonKey,
  type LoggedProjection,
} from './projection-history';
import { etDateKey } from './trading-calendar';
import { sectorOf } from './universe';

const DAY_MS = 86_400_000;
export const HORIZON_KEYS = Object.keys(HORIZONS) as HorizonKey[];
/** Calibration looks back this far (about 18 months of sessions at most). */
const LOOKBACK_DAYS = 550;
/** Symbols per calibration query batch (bounds memory). */
const BATCH = 200;
/** Logged projections are kept this long (graded ones feed the coverage record). */
export const PROJECTION_RETENTION_DAYS = 400;

/** The expiry a horizon logs: the one nearest its calendar-day target (within reason). */
export function expiryFor(expiries: readonly ExpiryProjection[], horizon: HorizonKey): ExpiryProjection | null {
  const target = HORIZONS[horizon].calendarDays;
  let best: ExpiryProjection | null = null;
  for (const e of expiries) {
    if (e.dte < target * 0.5 || e.dte > target * 1.8) continue;
    if (!best || Math.abs(e.dte - target) < Math.abs(best.dte - target)) best = e;
  }
  return best;
}

/** Monday (ET date key) of the week containing `day`. */
export function weekStart(day: Date): Date {
  const dow = day.getUTCDay(); // ET date keys are UTC-midnight dates
  return new Date(day.getTime() - ((dow + 6) % 7) * DAY_MS);
}

/** Log this week's projections, once (the first finalized session of the ET week). */
export async function logProjections(engine: FlowEngine, now = new Date()): Promise<number> {
  const today = etDateKey(now);
  const result = await tryDb('log projections', async (db) => {
    const already = await db.projectionLog.findFirst({ where: { loggedOn: { gte: weekStart(today) } }, select: { id: true } });
    if (already) return 0;
    const rows = [];
    for (const [symbol, p] of engine.projections) {
      // Only today's chains: a name the rotation has not reached today is skipped, not logged stale.
      if (etDateKey(new Date(p.dataAsOf)).getTime() !== today.getTime()) continue;
      for (const horizon of HORIZON_KEYS) {
        const e = expiryFor(p.expiries, horizon);
        if (!e) continue;
        const cal = engine.calibrations.get(symbol)?.[horizon];
        const [q025, q16, q50, q84, q975] = e.quantiles;
        rows.push({
          symbol,
          loggedOn: today,
          horizon,
          expiration: new Date(`${e.expiration}T00:00:00Z`),
          method: p.method,
          spot: p.spot,
          forward: e.forward,
          q025: q025 as number,
          q16: q16 as number,
          q50: q50 as number,
          q84: q84 as number,
          q975: q975 as number,
          calRatio: cal?.usable ? cal.ratio : null,
        });
      }
    }
    if (rows.length === 0) return 0;
    const { count } = await db.projectionLog.createMany({ data: rows, skipDuplicates: true });
    return count;
  });
  if (result) console.log(`[projection] logged ${result} weekly projections`);
  return result ?? 0;
}

/**
 * Grade projections whose expiry has a finalized close: the settled close on
 * the expiry date, or the last one before it if the name stopped trading
 * (graded to its last close, never dropped — survivorship).
 */
export async function gradeProjections(now = new Date()): Promise<number> {
  const result = await tryDb('grade projections', async (db) => {
    const latest = await db.dailyMetric.findFirst({
      where: { final: true, seeded: false, close: { not: null }, symbol: 'SPY' },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    if (!latest) return 0;
    const pending = await db.projectionLog.findMany({
      where: { outcome: null, expiration: { lte: latest.date } },
      select: { id: true, symbol: true, loggedOn: true, expiration: true },
    });
    const bySymbol = new Map<string, typeof pending>();
    for (const r of pending) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
    let graded = 0;
    for (const [symbol, rows] of bySymbol) {
      const from = new Date(Math.min(...rows.map((r) => r.loggedOn.getTime())));
      const to = new Date(Math.max(...rows.map((r) => r.expiration.getTime())));
      const closes = await db.dailyMetric.findMany({
        where: { symbol, final: true, seeded: false, close: { not: null }, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
        select: { date: true, close: true },
      });
      for (const r of rows) {
        let hit: { date: Date; close: number | null } | undefined;
        for (const c of closes) if (c.date > r.loggedOn && c.date <= r.expiration) hit = c;
        if (!hit || hit.close === null) continue;
        await db.projectionLog.update({ where: { id: r.id }, data: { outcome: hit.close, outcomeOn: hit.date } });
        graded += 1;
      }
    }
    // Retention: the coverage record keeps ~13 months.
    await db.projectionLog.deleteMany({ where: { loggedOn: { lt: new Date(now.getTime() - PROJECTION_RETENTION_DAYS * DAY_MS) } } });
    return graded;
  });
  if (result) console.log(`[projection] graded ${result} projections at expiry`);
  return result ?? 0;
}

const historyState = globalThis as unknown as { __projectionHistoryKey?: string };

/**
 * Nightly: calibration (realized vs implied) per name and sector, and graded
 * coverage, into the engine. Skips when nothing new was finalized.
 */
export async function refreshProjectionHistory(engine: FlowEngine): Promise<void> {
  await tryDb('refresh projection history', async (db) => {
    const latest = await db.dailyMetric.findFirst({
      where: { final: true, seeded: false, iv30: { not: null } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    const graded = await db.projectionLog.count({ where: { outcome: { not: null } } });
    const key = `${latest?.date.toISOString() ?? 'none'}|${graded}`;
    if (historyState.__projectionHistoryKey === key) return;

    // ── Calibration ──
    const first = await db.dailyMetric.findFirst({
      where: { final: true, seeded: false, iv30: { not: null }, date: { gte: new Date(Date.now() - LOOKBACK_DAYS * DAY_MS) } },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const calibrations = new Map<string, Record<HorizonKey, CalibrationView>>();
    if (first) {
      // The session clock: every date with any finalized close (backfill covers every trading day).
      const dates = await db.dailyMetric.groupBy({
        by: ['date'],
        where: { final: true, seeded: false, close: { not: null }, date: { gte: first.date } },
        orderBy: { date: 'asc' },
      });
      const sessionOf = new Map(dates.map((d, i) => [d.date.getTime(), i]));
      const symbols = (
        await db.dailyMetric.groupBy({ by: ['symbol'], where: { final: true, seeded: false, iv30: { not: null }, date: { gte: first.date } } })
      ).map((r) => r.symbol);

      const perTicker = new Map<string, Record<HorizonKey, { session: number; z: number }[]>>();
      const perSector = new Map<string, Record<HorizonKey, { session: number; z: number }[]>>();
      for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        const rows = await db.dailyMetric.findMany({
          where: { symbol: { in: batch }, final: true, seeded: false, close: { not: null }, date: { gte: first.date } },
          orderBy: [{ symbol: 'asc' }, { date: 'asc' }],
          select: { symbol: true, date: true, close: true, iv30: true },
        });
        const series = new Map<string, DayPoint[]>();
        for (const r of rows) {
          const session = sessionOf.get(r.date.getTime());
          if (session === undefined || r.close === null) continue;
          series.set(r.symbol, [...(series.get(r.symbol) ?? []), { session, close: r.close, iv30: r.iv30 }]);
        }
        for (const [symbol, pts] of series) {
          const moves = { week: standardizedMoves(pts, 'week'), month: standardizedMoves(pts, 'month') };
          perTicker.set(symbol, moves);
          const sector = sectorOf(symbol);
          const pool = perSector.get(sector) ?? { week: [], month: [] };
          for (const h of HORIZON_KEYS) pool[h].push(...moves[h]);
          perSector.set(sector, pool);
        }
      }
      const sectorStats = new Map(
        [...perSector].map(([sector, m]) => [sector, { week: calibrationStats(m.week, 'week'), month: calibrationStats(m.month, 'month') }]),
      );
      for (const [symbol, m] of perTicker) {
        const sec = sectorStats.get(sectorOf(symbol));
        if (!sec) continue;
        calibrations.set(symbol, {
          week: calibrationView(calibrationStats(m.week, 'week'), sec.week),
          month: calibrationView(calibrationStats(m.month, 'month'), sec.month),
        });
      }
    }
    engine.calibrations.clear();
    for (const [symbol, v] of calibrations) engine.calibrations.set(symbol, v);

    // ── Coverage of graded projections ──
    const gradedRows = await db.projectionLog.findMany({
      where: { outcome: { not: null }, method: PROJECTION_METHOD_VERSION },
      select: { symbol: true, horizon: true, forward: true, q025: true, q16: true, q84: true, q975: true, calRatio: true, outcome: true },
    });
    const empty = (): Record<HorizonKey, LoggedProjection[]> => ({ week: [], month: [] });
    const all = empty();
    const bySector = new Map<string, Record<HorizonKey, LoggedProjection[]>>();
    for (const r of gradedRows) {
      const h = r.horizon as HorizonKey;
      if (!(h in all)) continue;
      all[h].push(r);
      const sector = sectorOf(r.symbol);
      const bucket = bySector.get(sector) ?? empty();
      bucket[h].push(r);
      bySector.set(sector, bucket);
    }
    const summarize = (b: Record<HorizonKey, LoggedProjection[]>): Record<HorizonKey, Coverage> => ({
      week: coverage(b.week),
      month: coverage(b.month),
    });
    engine.projectionCoverage = {
      all: summarize(all),
      bySector: new Map([...bySector].map(([s, b]) => [s, summarize(b)])),
    };
    historyState.__projectionHistoryKey = key;
    console.log(`[projection] calibration for ${calibrations.size} names, ${gradedRows.length} graded projections`);
  });
}

/** One name's graded-projection coverage, by horizon (ticker page). */
export async function tickerCoverage(symbol: string): Promise<Record<HorizonKey, Coverage> | null> {
  return tryDb('ticker projection coverage', async (db) => {
    const rows = await db.projectionLog.findMany({
      where: { symbol, outcome: { not: null }, method: PROJECTION_METHOD_VERSION },
      select: { horizon: true, forward: true, q025: true, q16: true, q84: true, q975: true, calRatio: true, outcome: true },
    });
    return {
      week: coverage(rows.filter((r) => r.horizon === 'week')),
      month: coverage(rows.filter((r) => r.horizon === 'month')),
    };
  });
}
