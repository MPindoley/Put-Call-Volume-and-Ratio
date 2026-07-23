/**
 * Event maintenance jobs (Phase 3). DB-dependent; no-op without a database.
 *
 *  refreshIdiosyncraticEvents — detect large UNSCHEDULED single-name moves on the
 *      SPY-residual (its own feature; NOT an earnings source) and persist them.
 *  refreshEarningsRealized — fill realized moves for passed confirmed calendar
 *      events (manual + forward-confirmed), timing-aware.
 *  refreshEventGauges — load each ticker's confirmed-event distribution + active
 *      catalyst into engine.eventInputs, and the recent idiosyncratic moves into
 *      engine.idiosyncraticMoves, for the poll cycle to surface.
 */
import type { PrismaClient } from '@prisma/client';
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import { realizedEventMove, type GaugeEvent, type ReportTiming } from './earnings';
import { EdgarClient, type EdgarCacheStore } from './edgar';
import {
  computeMarketWideDates,
  detectIdiosyncraticEvents,
  DEFAULT_DETECT_OPTIONS,
  type DailyClose,
} from './idiosyncratic';
import type { EventGaugeInput } from './event-analytics';
import type { EventSource, IdiosyncraticMove } from '@/types';
import type { FlowEngine } from './flow-engine';
import { NOT_SEEDED } from './seed-guard';
import { etDateKey } from './trading-calendar';
import { TRACKED_UNIVERSE } from './universe';

const BENCHMARK = 'SPY'; // broad market — avoids mega-cap self-weight in concentrated sector ETFs
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** All tracked tickers' dated closes in one pass, keyed by symbol (ascending). */
async function allClosesBySymbol(db: PrismaClient): Promise<Map<string, DailyClose[]>> {
  const rows = await db.dailyMetric.findMany({
    where: { close: { not: null }, ...NOT_SEEDED },
    orderBy: { date: 'asc' },
    select: { symbol: true, date: true, close: true },
  });
  const map = new Map<string, DailyClose[]>();
  for (const r of rows) {
    if (r.close === null) continue;
    const list = map.get(r.symbol) ?? [];
    list.push({ date: iso(r.date), close: r.close });
    map.set(r.symbol, list);
  }
  return map;
}

function toReturns(closes: DailyClose[]): { date: string; ret: number }[] {
  const out: { date: string; ret: number }[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p0 = closes[i - 1]!.close;
    const p1 = closes[i]!.close;
    if (p0 > 0 && p1 > 0) out.push({ date: closes[i]!.date, ret: Math.log(p1 / p0) });
  }
  return out;
}

/**
 * Detect + persist large idiosyncratic (unscheduled) single-name moves, measured
 * against SPY. Returns the number written/updated. This feed is informational and
 * never enters the earnings distribution.
 */
export async function refreshIdiosyncraticEvents(): Promise<number> {
  const cfg = await getAnalyticsConfig();
  const opts = {
    ...DEFAULT_DETECT_OPTIONS,
    moveZ: cfg.inferMoveZ,
    minMovePct: cfg.inferMinMovePct,
    betaWindow: cfg.inferBetaWindow,
  };
  return (
    (await tryDb('refresh idiosyncratic events', async (db) => {
      const closesBySymbol = await allClosesBySymbol(db);
      const spy = closesBySymbol.get(BENCHMARK) ?? [];
      if (spy.length < 90) return 0;
      const marketWide = computeMarketWideDates(
        [...closesBySymbol.values()].map(toReturns),
        cfg.breadthMoveZ,
        cfg.breadthShare,
      );

      let written = 0;
      for (const { symbol } of TRACKED_UNIVERSE) {
        if (symbol === BENCHMARK) continue;
        const closes = closesBySymbol.get(symbol);
        if (!closes || closes.length < 90) continue;
        for (const ev of detectIdiosyncraticEvents(closes, spy, marketWide, opts)) {
          await db.idiosyncraticEvent.upsert({
            where: { symbol_date: { symbol, date: new Date(`${ev.date}T00:00:00Z`) } },
            create: {
              symbol,
              date: new Date(`${ev.date}T00:00:00Z`),
              movePct: ev.movePct,
              residualPct: ev.residualPct,
              residualZ: ev.residualZ,
              benchmark: BENCHMARK,
            },
            update: { movePct: ev.movePct, residualPct: ev.residualPct, residualZ: ev.residualZ, benchmark: BENCHMARK },
          });
          written += 1;
        }
      }
      return written;
    })) ?? 0
  );
}

/** Fill realized moves for passed confirmed calendar events lacking one. */
export async function refreshEarningsRealized(now = new Date()): Promise<number> {
  const today = iso(etDateKey(now));
  return (
    (await tryDb('refresh earnings realized', async (db) => {
      const closesBySymbol = await allClosesBySymbol(db);
      let updated = 0;
      const events = await db.earningsEvent.findMany({
        where: { realizedMovePct: null, ...NOT_SEEDED },
      });
      for (const e of events) {
        const eventIso = iso(e.date);
        if (eventIso >= today) continue; // not yet realized
        const closes = closesBySymbol.get(e.symbol);
        if (!closes) continue;
        // intraday releases are measured like before-open (prior-close → event-close).
        const timing: ReportTiming =
          e.reportTiming === 'amc' ? 'amc' : e.reportTiming === 'bmo' || e.reportTiming === 'intraday' ? 'bmo' : 'unknown';
        const move = realizedEventMove(eventIso, timing, new Map(closes.map((c) => [c.date, c.close])), closes.map((c) => c.date));
        if (!move) continue;
        await db.earningsEvent.update({
          where: { id: e.id },
          data: { realizedMovePct: move.movePct, realizedTimingUncertain: move.timingUncertain },
        });
        updated += 1;
      }
      return updated;
    })) ?? 0
  );
}

const DAY = 86_400_000;

/** DB-backed EDGAR fetch cache with a TTL, so a backfill never re-hits SEC. */
function edgarCacheStore(db: PrismaClient, ttlHours: number): EdgarCacheStore {
  const ttlMs = ttlHours * 3_600_000;
  return {
    async get(key) {
      const row = await db.edgarCache.findUnique({ where: { key } });
      if (!row) return null;
      return Date.now() - row.fetchedAt.getTime() > ttlMs ? null : row.json;
    },
    async put(key, json) {
      await db.edgarCache.upsert({
        where: { key },
        create: { key, json },
        update: { json, fetchedAt: new Date() },
      });
    },
  };
}

/**
 * Confirm earnings history from SEC EDGAR 8-K Item 2.02 for the configured
 * priority tickers. Quarterly-spaced filings become confirmed ground truth
 * (`source='edgar'`, timing derived from the acceptance timestamp); too-soon
 * filings are stored `pendingReview`. An EDGAR filing near an existing forward
 * candidate auto-confirms it in place rather than duplicating. Requires
 * SEC_CONTACT_EMAIL. Then fills realized moves on the correct session.
 */
export async function refreshEdgarConfirmations(now = new Date()): Promise<{ confirmed: number; pending: number }> {
  const cfg = await getAnalyticsConfig();
  if (cfg.edgarTickers.length === 0) return { confirmed: 0, pending: 0 };

  const result = await tryDb('edgar confirmations', async (db) => {
    let client: EdgarClient;
    try {
      client = new EdgarClient(process.env.SEC_CONTACT_EMAIL, edgarCacheStore(db, cfg.edgarCacheTtlHours));
    } catch (err) {
      console.warn('[edgar]', err instanceof Error ? err.message : err);
      return { confirmed: 0, pending: 0 };
    }
    let cikMap: Map<string, string>;
    try {
      cikMap = await client.cikMap();
    } catch (err) {
      console.warn('[edgar] CIK map fetch failed:', err instanceof Error ? err.message : err);
      return { confirmed: 0, pending: 0 };
    }

    let confirmed = 0;
    let pending = 0;
    for (const raw of cfg.edgarTickers) {
      const symbol = raw.toUpperCase();
      const cik = cikMap.get(symbol);
      if (!cik) {
        console.warn(`[edgar] no CIK for ${symbol}`);
        continue;
      }
      let events;
      try {
        events = await client.earningsEvents(cik, cfg.edgarMinSpacingDays);
      } catch (err) {
        console.warn(`[edgar] ${symbol} submissions failed:`, err instanceof Error ? err.message : err);
        continue;
      }
      const existing = await db.earningsEvent.findMany({ where: { symbol } });
      for (const e of events) {
        const date = new Date(`${e.reportDate}T00:00:00Z`);
        const data = {
          source: 'edgar',
          confirmed: e.confirmed,
          pendingReview: e.pendingReview,
          reportTiming: e.timing,
          acceptedAt: e.acceptedAt,
        };
        const exact = existing.find((x) => iso(x.date) === e.reportDate);
        // A bulge-identified forward guess within a few days → the EDGAR actual supersedes it.
        const near = existing.find(
          (x) => x.source === 'forward' && iso(x.date) !== e.reportDate && Math.abs(x.date.getTime() - date.getTime()) <= 5 * DAY,
        );
        if (exact) {
          if (exact.source !== 'manual') await db.earningsEvent.update({ where: { id: exact.id }, data });
        } else if (near) {
          await db.earningsEvent.update({
            where: { id: near.id },
            data: { ...data, date, realizedMovePct: null, realizedTimingUncertain: false },
          });
        } else {
          await db.earningsEvent.create({ data: { symbol, date, ...data } });
        }
        if (e.confirmed) confirmed += 1;
        else pending += 1;
      }
    }
    return { confirmed, pending };
  });

  await refreshEarningsRealized(now); // measure on the correct session now timing is known
  return result ?? { confirmed: 0, pending: 0 };
}

/**
 * Load per-ticker confirmed-event distributions + active catalyst into
 * engine.eventInputs, and recent idiosyncratic moves into engine.idiosyncraticMoves.
 */
export async function refreshEventGauges(engine: FlowEngine, now = new Date()): Promise<void> {
  const cfg = await getAnalyticsConfig();
  const today = iso(etDateKey(now));
  const floor = { minOpenInterest: cfg.eventMinOI, maxQuoteWidthFrac: cfg.eventMaxQuoteWidth };

  await tryDb('refresh event gauges', async (db) => {
    engine.eventInputs.clear();
    engine.idiosyncraticMoves.clear();
    for (const { symbol } of TRACKED_UNIVERSE) {
      // Idiosyncratic feed (most recent first).
      const idio = await db.idiosyncraticEvent.findMany({
        where: { symbol, ...NOT_SEEDED },
        orderBy: { date: 'desc' },
        take: 8,
      });
      if (idio.length > 0) {
        const moves: IdiosyncraticMove[] = idio.map((r) => ({
          date: iso(r.date),
          movePct: r.movePct,
          residualZ: Number(r.residualZ.toFixed(1)),
        }));
        engine.idiosyncraticMoves.set(symbol, moves);
      }

      // Confirmed calendar events for the rich/cheap distribution.
      const rows = await db.earningsEvent.findMany({ where: { symbol, ...NOT_SEEDED }, orderBy: { date: 'asc' } });
      const events: GaugeEvent[] = rows.map((r) => ({
        source: r.source as 'manual' | 'forward',
        confirmed: r.confirmed,
        realizedMovePct: r.realizedMovePct,
        realizedTimingUncertain: r.realizedTimingUncertain,
      }));

      // Active catalyst: nearest upcoming CONFIRMED event, else the live bulge (display only).
      const upcoming = rows
        .filter((r) => r.confirmed && iso(r.date) >= today)
        .sort((a, b) => a.date.getTime() - b.date.getTime())[0];
      let eventDate: string | null = null;
      let eventSource: EventSource | null = null;
      let reportTiming: ReportTiming | null = null;
      if (upcoming) {
        eventDate = iso(upcoming.date);
        eventSource = upcoming.source as EventSource;
        reportTiming = (['bmo', 'amc', 'unknown'].includes(upcoming.reportTiming)
          ? upcoming.reportTiming
          : 'unknown') as ReportTiming;
      } else {
        const bulge = engine.getFlow(symbol)?.analytics?.eventExpiry ?? null;
        if (bulge && bulge >= today) {
          eventDate = bulge;
          eventSource = 'bulge';
          reportTiming = 'unknown';
        }
      }

      if (eventDate === null && events.length === 0) continue;
      const input: EventGaugeInput = {
        eventDate,
        eventSource,
        reportTiming,
        events,
        requiredCount: cfg.minConfirmedEvents,
        floor,
      };
      engine.eventInputs.set(symbol, input);
    }
  });
}
