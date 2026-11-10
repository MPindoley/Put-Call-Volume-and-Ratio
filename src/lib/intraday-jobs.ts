/**
 * The daily clock's I/O (intraday-profile.ts is the math).
 *
 *  foldIntradayProfiles — nightly: fold each finished session's 5-minute
 *                         snapshots into every name's running profile, while
 *                         the detail still exists (it is thinned after a few
 *                         days). A session is folded exactly once.
 *  loadClocksIntoEngine — resolve the stored sums into every name's clock and
 *                         hand them to the spike detector.
 *  loadClockReport      — one name's clock beside today's actual volume, for
 *                         the ticker page.
 *  clockSummary         — the Learning page's overview.
 */
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import {
  AFTER_CLOSE_MS,
  BUCKETS,
  bucketLabel,
  bucketVolumes,
  CLOCK_METHOD,
  CLOCK_PARAMS,
  DAY_TYPES,
  dayTypeOf,
  DEFAULT_INTRADAY_SHAPE,
  foldSession,
  reactionSessions,
  resolveClocks,
  sessionShape,
  shapePutShare,
  shapeTotals,
  type DayType,
  type ProfileRow,
  type Shape,
  type VolumePoint,
} from './intraday-profile';
import { NOT_SEEDED } from './seed-guard';
import { etTimeParts, isSessionDate, pastCaptureStart, sessionBounds, shiftIso } from './trading-calendar';
import { sectorOf, TRACKED_UNIVERSE } from './universe';
import type { PrismaClient } from '@prisma/client';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (dateKey: string): Date => new Date(`${dateKey}T00:00:00Z`);
/** A snapshot row holds the latest volumes seen in its 5-minute bucket: date it at the bucket's middle. */
const BUCKET_MID_MS = 150_000;

/** symbol → the sessions (ET dates, within [from, to]) on which it trades a confirmed earnings report. */
export async function earningsSessions(db: PrismaClient, from: string, to: string): Promise<Map<string, Set<string>>> {
  const events = await db.earningsEvent.findMany({
    // A report dated up to a long weekend before `from` can still be traded on it.
    where: { confirmed: true, ...NOT_SEEDED, date: { gte: utc(shiftIso(from, -6)), lte: utc(to) } },
    select: { symbol: true, date: true, reportTiming: true },
  });
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    for (const session of reactionSessions(iso(e.date), e.reportTiming)) {
      if (session < from || session > to) continue;
      const set = out.get(e.symbol) ?? new Set<string>();
      set.add(session);
      out.set(e.symbol, set);
    }
  }
  return out;
}

const toRow = (r: {
  symbol: string;
  dayType: string;
  putSum: number[];
  callSum: number[];
  weight: number;
  sessions: number;
}): ProfileRow => ({
  symbol: r.symbol,
  dayType: (DAY_TYPES as readonly string[]).includes(r.dayType) ? (r.dayType as DayType) : 'regular',
  putSum: r.putSum,
  callSum: r.callSum,
  weight: r.weight,
  sessions: r.sessions,
});

/** One session's snapshots as cumulative-volume points per symbol. */
async function sessionPoints(
  db: PrismaClient,
  openMs: number,
  closeMs: number,
  symbol?: string,
): Promise<Map<string, VolumePoint[]>> {
  const rows = await db.flowSnapshot.findMany({
    where: {
      ...(symbol ? { symbol } : {}),
      bucketStart: { gte: new Date(openMs - BUCKET_MID_MS), lte: new Date(closeMs + AFTER_CLOSE_MS) },
    },
    select: { symbol: true, bucketStart: true, putVolume: true, callVolume: true },
    orderBy: { bucketStart: 'asc' },
  });
  const out = new Map<string, VolumePoint[]>();
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ t: r.bucketStart.getTime() + BUCKET_MID_MS, put: r.putVolume, call: r.callVolume });
    out.set(r.symbol, list);
  }
  return out;
}

export interface FoldResult {
  /** Sessions folded in this run. */
  sessions: number;
  /** Name-sessions added across them. */
  profiles: number;
}

/**
 * Fold every finished session not yet counted into the running profiles.
 * Looks back `lookbackDays` (the span snapshots keep their intraday detail);
 * half days are skipped — their clock is not a regular day's. Today counts
 * once the end-of-day capture window has passed, so the day's totals are in.
 */
export async function foldIntradayProfiles(now = new Date(), lookbackDays = 5): Promise<FoldResult> {
  const cfg = await getAnalyticsConfig();
  const out: FoldResult = { sessions: 0, profiles: 0 };
  await tryDb('fold intraday profiles', async (db) => {
    // Sums under an older method mean something else: start again.
    await db.intradayProfile.deleteMany({ where: { method: { not: CLOCK_METHOD } } });
    const existing = new Map((await db.intradayProfile.findMany()).map((r) => [`${r.symbol}|${r.dayType}`, r] as const));
    let lastFolded = '';
    for (const r of existing.values()) if (iso(r.lastSession) > lastFolded) lastFolded = iso(r.lastSession);

    const today = etTimeParts(now).dateKey;
    const todayDone = pastCaptureStart(now, cfg.captureDelayMin + cfg.captureWindowMin);
    const pending: string[] = [];
    for (let back = lookbackDays; back >= 0; back--) {
      const d = shiftIso(today, -back);
      if (d <= lastFolded || !isSessionDate(d) || (d === today && !todayDone)) continue;
      if (sessionBounds(d)!.earlyClose) continue;
      pending.push(d);
    }
    if (pending.length === 0) return;

    const earnings = await earningsSessions(db, pending[0]!, pending[pending.length - 1]!);
    for (const session of pending) {
      const { openMs, closeMs } = sessionBounds(session)!;
      const points = await sessionPoints(db, openMs, closeMs);
      const next: {
        symbol: string;
        dayType: DayType;
        putSum: number[];
        callSum: number[];
        weight: number;
        sessions: number;
        lastSession: Date;
        method: string;
      }[] = [];
      for (const [symbol, series] of points) {
        const shape = sessionShape(series, openMs);
        if (!shape) continue;
        const dayType = dayTypeOf(session, earnings.get(symbol));
        const prev = existing.get(`${symbol}|${dayType}`) ?? null;
        if (prev && iso(prev.lastSession) >= session) continue; // never counted twice
        next.push({ symbol, dayType, ...foldSession(prev, shape), lastSession: utc(session), method: CLOCK_METHOD });
      }
      if (next.length === 0) continue;
      // One transaction per session: either every name's profile takes it, or none does.
      await db.$transaction([
        ...DAY_TYPES.map((t) =>
          db.intradayProfile.deleteMany({
            where: { dayType: t, symbol: { in: next.filter((r) => r.dayType === t).map((r) => r.symbol) } },
          }),
        ),
        db.intradayProfile.createMany({ data: next }),
      ]);
      for (const r of next) existing.set(`${r.symbol}|${r.dayType}`, { ...r, updatedAt: now });
      out.sessions += 1;
      out.profiles += next.length;
    }
  });
  if (out.sessions > 0)
    console.log(`[clock] folded ${out.sessions} session(s) into the daily clocks (${out.profiles} name-sessions)`);
  return out;
}

/** Resolve the stored profiles into every tracked name's clock and hand them to the spike detector. */
export async function loadClocksIntoEngine(engine: FlowEngine, now = new Date()): Promise<number> {
  const loaded = await tryDb('load daily clocks', async (db) => {
    const rows = await db.intradayProfile.findMany({ where: { method: CLOCK_METHOD } });
    if (rows.length === 0) return 0;
    const book = resolveClocks(rows.map(toRow), TRACKED_UNIVERSE);
    const today = etTimeParts(now).dateKey;
    // Back far enough to cover the latest session from any weekend or holiday (the
    // ticker page shows it), forward far enough for a server left running a week.
    const earnings = await earningsSessions(db, shiftIso(today, -6), shiftIso(today, 10));
    const asOf = rows.reduce((m, r) => (iso(r.lastSession) > m ? iso(r.lastSession) : m), '');
    engine.setClocks(book, earnings, asOf || null);
    return rows.length;
  });
  return loaded ?? 0;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface ClockBucket {
  /** ET start of the half hour, "9:30". */
  label: string;
  /** Usual share of the day's volume in this half hour (0–1): this name, its sector, all names. */
  share: number;
  sectorShare: number;
  allShare: number;
  /** Usual fraction of this half hour's volume that is puts (0–1). */
  putShare: number | null;
  /** Usual contracts in this half hour: the 20-day average day × share. Null without a volume baseline. */
  expected: number | null;
  /** Contracts actually traded in it on the session shown; null where the data does not reach. */
  actual: number | null;
  actualPutShare: number | null;
  /** The session shown is still inside this half hour. */
  partial: boolean;
}

export interface ClockReport {
  symbol: string;
  sector: string;
  /** False until any session has been folded: the buckets then show the fixed starting curve. */
  learned: boolean;
  /** Latest session folded into the clocks. */
  asOf: string | null;
  /** The session `actual` describes (the name's latest data), and what kind of day it is. */
  session: string | null;
  dayType: DayType;
  /** The name's own sessions on record, per kind of day. */
  ownSessions: Record<DayType, number>;
  /** How much of the regular-day clock is the name's own data (0–1); the rest is its sector's. */
  ownShare: number;
  avgDailyVolume: number | null;
  /** Minutes after the open the session shown runs to. */
  throughMin: number | null;
  /** The session's 5-minute data has a hole too wide to split it into half hours: `actual` is left out. */
  sessionGaps: boolean;
  buckets: ClockBucket[];
}

const FIXED: Shape = { put: DEFAULT_INTRADAY_SHAPE.map((x) => x / 2), call: DEFAULT_INTRADAY_SHAPE.map((x) => x / 2) };

/** One name's learned clock beside what it actually traded on its latest session. */
export async function loadClockReport(engine: FlowEngine, symbol: string, now = new Date()): Promise<ClockReport> {
  const sector = sectorOf(symbol);
  const book = engine.clocks;
  const clock = book?.stocks.get(symbol) ?? null;
  const flow = engine.getFlow(symbol);
  // The session the name's data is from; before its first fetch, today.
  const dataDate = flow && flow.dataAsOf > 0 ? etTimeParts(new Date(flow.dataAsOf)).dateKey : etTimeParts(now).dateKey;
  const session = isSessionDate(dataDate) ? dataDate : null;
  const dayType = session ? engine.detector.dayType(symbol, new Date(sessionBounds(session)!.openMs)) : 'regular';
  const shape = clock?.shapes[dayType] ?? FIXED;
  const sectorShape = book?.sectors.get(sector)?.[dayType] ?? FIXED;
  const allShape = book?.all[dayType] ?? FIXED;

  let actual: ReturnType<typeof bucketVolumes> = null;
  if (session) {
    const { openMs, closeMs, closeMin } = sessionBounds(session)!;
    const points = await tryDb('clock session', (db) => sessionPoints(db, openMs, closeMs, symbol));
    actual = bucketVolumes(points?.get(symbol) ?? [], openMs, closeMin);
  }
  // A half hour interpolated across a long gap is a guess, not a measurement.
  const sessionGaps = actual !== null && actual.worstGapMin > CLOCK_PARAMS.maxGapMin;
  if (sessionGaps) actual = null;

  const totals = shapeTotals(shape);
  const sectorTotals = shapeTotals(sectorShape);
  const allTotals = shapeTotals(allShape);
  const putShares = shapePutShare(shape);
  const avg = engine.detector.baseline(symbol)?.avgDailyVolume ?? 0;
  const buckets: ClockBucket[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const put = actual?.put[b] ?? null;
    const call = actual?.call[b] ?? null;
    const traded = put !== null && call !== null ? put + call : null;
    buckets.push({
      label: bucketLabel(b),
      share: totals[b]!,
      sectorShare: sectorTotals[b]!,
      allShare: allTotals[b]!,
      putShare: putShares[b] ?? null,
      expected: avg > 0 ? avg * totals[b]! : null,
      actual: traded,
      actualPutShare: traded !== null && traded > 0 ? put! / traded : null,
      partial: actual !== null && !actual.complete && traded !== null && actual.throughMin < (b + 1) * 30,
    });
  }
  return {
    symbol,
    sector,
    learned: clock !== null,
    asOf: engine.clocksAsOf,
    session,
    dayType,
    ownSessions: {
      regular: clock?.own.regular.sessions ?? 0,
      expiry: clock?.own.expiry.sessions ?? 0,
      earnings: clock?.own.earnings.sessions ?? 0,
    },
    ownShare: clock?.ownShare ?? 0,
    avgDailyVolume: avg > 0 ? avg : null,
    throughMin: actual?.throughMin ?? null,
    sessionGaps,
    buckets,
  };
}

export interface ClockSummary {
  learned: boolean;
  asOf: string | null;
  /** Tracked names, and how many have any sessions of their own / enough that their clock is mostly their own. */
  names: number;
  withOwnData: number;
  mostlyOwn: number;
  /** The most sessions any name has on record. */
  maxSessions: number;
  /** The all-names clock per kind of day: share of the day's volume per half hour. */
  all: { label: string; regular: number; expiry: number; earnings: number }[];
  params: { halfLife: number; stockPrior: number };
}

/** The Learning page's overview of the clocks in memory. */
export function clockSummary(engine: FlowEngine): ClockSummary {
  const book = engine.clocks;
  const stocks = book ? [...book.stocks.values()] : [];
  const all = book?.all ?? { regular: FIXED, expiry: FIXED, earnings: FIXED };
  const totals = { regular: shapeTotals(all.regular), expiry: shapeTotals(all.expiry), earnings: shapeTotals(all.earnings) };
  return {
    learned: book !== null,
    asOf: engine.clocksAsOf,
    names: TRACKED_UNIVERSE.length,
    withOwnData: stocks.filter((c) => c.own.regular.sessions > 0).length,
    mostlyOwn: stocks.filter((c) => c.ownShare >= 0.5).length,
    maxSessions: stocks.reduce(
      (m, c) => Math.max(m, c.own.regular.sessions + c.own.expiry.sessions + c.own.earnings.sessions),
      0,
    ),
    all: Array.from({ length: BUCKETS }, (_, b) => ({
      label: bucketLabel(b),
      regular: totals.regular[b]!,
      expiry: totals.expiry[b]!,
      earnings: totals.earnings[b]!,
    })),
    params: { halfLife: CLOCK_PARAMS.halfLife, stockPrior: CLOCK_PARAMS.prior.stock },
  };
}
