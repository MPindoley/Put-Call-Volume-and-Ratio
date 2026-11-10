/**
 * Spike follow-through I/O (spike-outcomes.ts is the math).
 *
 *  gradeSpikeAlerts       — fill in what the price did after each alert:
 *                           the intraday windows once its session has ended
 *                           (from the 5-minute snapshots, while they still have
 *                           their detail), the close-based ones once the next
 *                           session has settled.
 *  loadSpikeBookIntoEngine — tally the graded alerts into the book the engine
 *                           quotes on live alerts.
 *  loadSpikeReport        — one name's tables and its recent graded alerts.
 */
import type { PrismaClient } from '@prisma/client';
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import { finalizedMetricWhere } from './finalized-reads';
import type { FlowEngine } from './flow-engine';
import { AFTER_CLOSE_MS } from './intraday-profile';
import {
  buildSpikeBook,
  dayPartOf,
  gradeCloses,
  gradeIntraday,
  leanOf,
  spikeTable,
  SPIKE_PARAMS,
  type DayPart,
  type Lean,
  type PricePoint,
  type SpikeBook,
  type SpikeObs,
  type SpikeTable,
} from './spike-outcomes';
import {
  etTimeParts,
  isSessionDate,
  nextSessionDate,
  pastCaptureStart,
  sessionBounds,
  tradingDaysBetween,
} from './trading-calendar';
import { sectorOf } from './universe';

const DAY_MS = 86_400_000;
const BUCKET_MID_MS = 150_000;
/** Alerts older than this that are still ungraded never will be: their prices are gone. */
const GIVE_UP_DAYS = 12;
/** How long graded alerts are kept and learned from (history-jobs.ts prunes at the same horizon). */
export const SPIKE_HISTORY_DAYS = 400;
const utc = (dateKey: string): Date => new Date(`${dateKey}T00:00:00Z`);
const round = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(3)));

/** The session's stored prices for some names, time-sorted, keyed by symbol. */
async function sessionPrices(
  db: PrismaClient,
  symbols: string[],
  openMs: number,
  closeMs: number,
): Promise<Map<string, PricePoint[]>> {
  const rows = await db.flowSnapshot.findMany({
    where: {
      symbol: { in: symbols },
      bucketStart: { gte: new Date(openMs - BUCKET_MID_MS), lte: new Date(closeMs + AFTER_CLOSE_MS) },
      underlying: { not: null },
    },
    select: { symbol: true, bucketStart: true, underlying: true },
    orderBy: { bucketStart: 'asc' },
  });
  const out = new Map<string, PricePoint[]>();
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ t: r.bucketStart.getTime() + BUCKET_MID_MS, price: r.underlying as number });
    out.set(r.symbol, list);
  }
  return out;
}

/** Settled closes on one session for some names. */
async function settledCloses(db: PrismaClient, symbols: string[], session: string): Promise<Map<string, number>> {
  const rows = await db.dailyMetric.findMany({
    where: finalizedMetricWhere({ symbol: { in: symbols }, date: utc(session), close: { not: null } }),
    select: { symbol: true, close: true },
  });
  return new Map(rows.map((r) => [r.symbol, r.close as number]));
}

export interface GradeResult {
  /** Alerts whose intraday windows were graded in this run. */
  intraday: number;
  /** Alerts finished in this run (closes graded, or given up). */
  finished: number;
}

/**
 * Grade pending alerts. Safe to run on every maintenance pass: an alert moves
 * forward only when what its next stage needs is on record.
 */
export async function gradeSpikeAlerts(now = new Date()): Promise<GradeResult> {
  const cfg = await getAnalyticsConfig();
  const out: GradeResult = { intraday: 0, finished: 0 };
  await tryDb('grade spike alerts', async (db) => {
    const gaveUp = await db.alert.updateMany({
      where: { gradeStage: { lt: 2 }, createdAt: { lt: new Date(now.getTime() - GIVE_UP_DAYS * DAY_MS) } },
      data: { gradeStage: 2 },
    });
    out.finished += gaveUp.count;

    const pending = await db.alert.findMany({
      where: { gradeStage: { lt: 2 } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, symbol: true, createdAt: true, gradeStage: true, priceAt: true, spyAt: true, moveClose: true },
    });
    if (pending.length === 0) return;
    const today = etTimeParts(now).dateKey;
    const todayDone = pastCaptureStart(now, cfg.captureDelayMin + cfg.captureWindowMin);
    const bySession = new Map<string, typeof pending>();
    for (const a of pending) {
      const session = etTimeParts(a.createdAt).dateKey;
      const list = bySession.get(session) ?? [];
      list.push(a);
      bySession.set(session, list);
    }

    for (const [session, alerts] of bySession) {
      const bounds = sessionBounds(session);
      if (!bounds || !isSessionDate(session)) {
        // Appeared on a day with no session: nothing to measure against.
        await db.alert.updateMany({ where: { id: { in: alerts.map((a) => a.id) } }, data: { gradeStage: 2 } });
        out.finished += alerts.length;
        continue;
      }
      if (session > today || (session === today && !todayDone)) continue; // the session is still running
      const symbols = [...new Set(alerts.map((a) => a.symbol)), 'SPY'];
      const fresh = alerts.filter((a) => a.gradeStage === 0);
      const prices =
        fresh.length > 0 ? await sessionPrices(db, symbols, bounds.openMs, bounds.closeMs) : new Map<string, PricePoint[]>();
      const closes = await settledCloses(db, symbols, session);
      const nextSession = nextSessionDate(session);
      const nextCloses = nextSession <= today ? await settledCloses(db, symbols, nextSession) : new Map<string, number>();
      // Past this point the next close will not arrive either (a name that stopped trading).
      const overdue = tradingDaysBetween(new Date(bounds.closeMs), now) > 5;

      const updates = [];
      for (const a of alerts) {
        const created = a.createdAt.getTime();
        const afterBell = created > bounds.closeMs;
        const data: Record<string, number | null> = {};
        let priceAt = a.priceAt;
        let spyAt = a.spyAt;
        let stage = a.gradeStage;
        if (stage === 0) {
          const g = gradeIntraday(created, bounds.openMs, bounds.closeMs, prices.get(a.symbol) ?? [], prices.get('SPY') ?? []);
          priceAt = g.priceAt;
          spyAt = g.spyAt;
          Object.assign(data, {
            priceAt,
            spyAt,
            move30m: round(g.move30m),
            move2h: round(g.move2h),
            spy30m: round(g.spy30m),
            spy2h: round(g.spy2h),
          });
          stage = 1;
          out.intraday += 1;
        }
        const close = closes.get(a.symbol) ?? null;
        const nextClose = nextCloses.has('SPY') ? (nextCloses.get(a.symbol) ?? null) : null;
        const g = gradeCloses({
          afterBell,
          priceAt,
          spyAt,
          close,
          nextClose,
          spyClose: closes.get('SPY') ?? null,
          spyNextClose: nextCloses.get('SPY') ?? null,
        });
        // The same-session close counts as soon as it has settled; an alert that
        // appeared after the bell starts from it.
        if (a.moveClose === null && g.moveClose !== null)
          Object.assign(data, { moveClose: round(g.moveClose), spyClose: round(g.spyClose) });
        if (afterBell && priceAt === null && g.priceAt !== null) Object.assign(data, { priceAt: g.priceAt, spyAt: g.spyAt });
        // Finished once the next session has settled — or when nothing more can
        // be measured: no starting price, or a next close that never arrived.
        if ((!afterBell && priceAt === null) || nextClose !== null || overdue) {
          Object.assign(data, { moveNext: round(g.moveNext), spyNext: round(g.spyNext) });
          stage = 2;
          out.finished += 1;
        }
        if (stage !== a.gradeStage || Object.keys(data).length > 0) {
          updates.push(db.alert.update({ where: { id: a.id }, data: { ...data, gradeStage: stage } }));
        }
      }
      if (updates.length > 0) await db.$transaction(updates);
    }
  });
  if (out.intraday > 0 || out.finished > 0) {
    console.log(`[spikes] graded ${out.intraday} alert(s) intraday, finished ${out.finished}`);
  }
  return out;
}

interface GradedAlert {
  symbol: string;
  createdAt: Date;
  putCallRatio: number;
  priceAt: number | null;
  move30m: number | null;
  move2h: number | null;
  moveClose: number | null;
  moveNext: number | null;
  spy30m: number | null;
  spy2h: number | null;
  spyClose: number | null;
  spyNext: number | null;
}

const GRADED_SELECT = {
  symbol: true,
  createdAt: true,
  putCallRatio: true,
  priceAt: true,
  move30m: true,
  move2h: true,
  moveClose: true,
  moveNext: true,
  spy30m: true,
  spy2h: true,
  spyClose: true,
  spyNext: true,
} as const;

/** When in its session an alert appeared, and which way it leaned. */
function classify(a: { createdAt: Date; putCallRatio: number }): { session: string; part: DayPart; lean: Lean } {
  const session = etTimeParts(a.createdAt).dateKey;
  const openMs = sessionBounds(session)?.openMs ?? a.createdAt.getTime();
  return { session, part: dayPartOf((a.createdAt.getTime() - openMs) / 60_000), lean: leanOf(a.putCallRatio) };
}

function toObs(a: GradedAlert, now: Date): SpikeObs {
  const sector = sectorOf(a.symbol);
  return {
    symbol: a.symbol,
    sector,
    isEtf: sector === 'ETF',
    createdAt: a.createdAt.getTime(),
    age: tradingDaysBetween(a.createdAt, now),
    ...classify(a),
    move: { m30: a.move30m, h2: a.move2h, close: a.moveClose, next: a.moveNext },
    spy: { m30: a.spy30m, h2: a.spy2h, close: a.spyClose, next: a.spyNext },
  };
}

/** Tally every graded alert on record into the book the engine quotes from. Returns the episodes behind it. */
export async function loadSpikeBookIntoEngine(engine: FlowEngine, now = new Date()): Promise<number> {
  const book = await tryDb('load spike book', async (db): Promise<SpikeBook> => {
    const rows = await db.alert.findMany({
      where: {
        gradeStage: { gte: 1 },
        priceAt: { not: null },
        createdAt: { gte: new Date(now.getTime() - SPIKE_HISTORY_DAYS * DAY_MS) },
      },
      select: GRADED_SELECT,
    });
    return buildSpikeBook(rows.map((r) => toObs(r, now)));
  });
  if (book) engine.spikeBook = book;
  return book?.episodes ?? 0;
}

export interface RecentSpike {
  /** Epoch ms the alert appeared. */
  at: number;
  part: DayPart;
  lean: Lean;
  level: string;
  volumeMultiple: number;
  /** % moves of the underlying after the alert; null = not measured (yet). */
  move30m: number | null;
  move2h: number | null;
  moveClose: number | null;
  moveNext: number | null;
  /** Still being graded (its session or the next has not settled). */
  pending: boolean;
}

export interface SpikeReport {
  symbol: string;
  sector: string;
  isEtf: boolean;
  /** Episodes behind the whole book (all names). */
  episodes: number;
  /** Graded spikes an all-names cell needs before its numbers are shown. */
  minRoot: number;
  /** This name, its sector, all names (an ETF has no sector table). */
  tables: SpikeTable[];
  recent: RecentSpike[];
}

/** One name's follow-through tables at each level, and its latest alerts with what followed. */
export async function loadSpikeReport(engine: FlowEngine, symbol: string): Promise<SpikeReport> {
  const sector = sectorOf(symbol);
  const isEtf = sector === 'ETF';
  const book = engine.spikeBook ?? { cells: new Map(), episodes: 0 };
  const target = { symbol, sector, isEtf };
  const recent = await tryDb('recent spikes', (db) =>
    db.alert.findMany({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { ...GRADED_SELECT, level: true, volumeMultiple: true, gradeStage: true },
    }),
  );
  return {
    symbol,
    sector,
    isEtf,
    episodes: book.episodes,
    minRoot: SPIKE_PARAMS.minRoot,
    tables: (isEtf ? (['ticker', 'all'] as const) : (['ticker', 'sector', 'all'] as const)).map((level) =>
      spikeTable(book, target, level),
    ),
    recent: (recent ?? []).map((a) => ({
      at: a.createdAt.getTime(),
      ...classify(a),
      level: a.level,
      volumeMultiple: a.volumeMultiple,
      move30m: a.move30m,
      move2h: a.move2h,
      moveClose: a.moveClose,
      moveNext: a.moveNext,
      pending: a.gradeStage < 2,
    })),
  };
}

export interface SpikeSummary {
  episodes: number;
  minRoot: number;
  /** Alerts on record still waiting for a session to settle. */
  pending: number;
  /** All single names together. */
  table: SpikeTable;
}

/** The Learning page's overview: the all-names table and how much is graded. */
export async function loadSpikeSummary(engine: FlowEngine): Promise<SpikeSummary> {
  const book = engine.spikeBook ?? { cells: new Map(), episodes: 0 };
  const pending = await tryDb('pending spikes', (db) => db.alert.count({ where: { gradeStage: { lt: 2 } } }));
  return {
    episodes: book.episodes,
    minRoot: SPIKE_PARAMS.minRoot,
    pending: pending ?? 0,
    table: spikeTable(book, { isEtf: false }, 'all'),
  };
}
