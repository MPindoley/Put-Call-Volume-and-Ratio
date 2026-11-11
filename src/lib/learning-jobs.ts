/**
 * Nightly learning job: write the edge book for every finalized session that
 * does not yet have one under the current learning version.
 *
 * On a normal night that is exactly one book — today's — written right after
 * signals are graded (runMaintenance). On first run, or after a version change,
 * it reconstructs books for past sessions too, flagged `reconstructed`. That is
 * safe because each book is point-in-time by construction (learning.ts), and it
 * means self-grading has a history to work with immediately instead of starting
 * from zero.
 *
 * Books are immutable: an existing (asOf, version) row is never rewritten.
 */
import { Prisma } from '@prisma/client';
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import { finalizedMetricWhere } from './finalized-reads';
import type { FlowEngine } from './flow-engine';
import {
  buildBaseRates,
  establishedCounts,
  LEARNING_PARAMS,
  type Calibration,
  type EdgeBook,
  type Level,
  type NodeStats,
} from './learning';
import {
  baseRateSweep,
  bookAt,
  bookFromRow,
  convictionsAt,
  currentLearningVersion,
  deriveLearningInputs,
  invalidateTimingBooks,
  loadLearningInputs,
  loadLearningRows,
  parseConvictions,
  selfGrade,
  serializeConvictions,
  type FrozenRun,
  type LearningInputs,
  type LearningRows,
} from './learning-data';
import { buildComboBook, compactComboBook } from './signal-combos';
import { TIMING_HORIZONS } from './signal-timing';
import { isTradingDay } from './trading-calendar';
import type { PrismaClient } from '@prisma/client';

/** Upper bound on books reconstructed in one run (one trading year). */
const MAX_BACKFILL_BOOKS = 252;

export interface RefreshResult {
  version: string;
  written: number;
  reconstructed: number;
  latestAsOf: string | null;
}

export async function refreshEdgeBooks(): Promise<RefreshResult | null> {
  return tryDb('refresh edge books', async (db) => {
    const rows = await loadLearningRows(db);
    if (!rows) return null;
    const inputs = deriveLearningInputs(rows);
    const { sessions, version } = inputs;
    const lastIdx = sessions.length - 1;

    // Nothing to learn before the first outcome is knowable.
    const firstKnown = inputs.evidence.reduce((m, e) => Math.min(m, e.knownIdx), Infinity);
    const start = Math.max(Number.isFinite(firstKnown) ? firstKnown : lastIdx, lastIdx - MAX_BACKFILL_BOOKS + 1);

    const existing = await db.edgeBook.findMany({
      where: { version, asOf: { gte: new Date(`${sessions[Math.max(0, start)]}T00:00:00Z`) } },
      select: { asOf: true },
    });
    const have = new Set(existing.map((b) => b.asOf.toISOString().slice(0, 10)));

    let written = 0;
    let reconstructed = 0;
    const sweep = baseRateSweep(inputs); // one forward pass for the whole backfill
    for (let a = Math.max(0, start); a <= lastIdx; a++) {
      if (have.has(sessions[a]!)) continue;
      const book = bookAt(inputs, a, sweep.advanceTo(a).lookup);
      const isReconstruction = a < lastIdx;
      try {
        await db.edgeBook.create({
          data: {
            asOf: new Date(`${sessions[a]}T00:00:00Z`),
            version,
            rowsUsed: book.rowsUsed,
            rowsUnbased: book.rowsUnbased,
            nodes: book.nodes as unknown as Prisma.InputJsonValue,
            convictions: serializeConvictions(convictionsAt(inputs, book, a)) as Prisma.InputJsonValue,
            reconstructed: isReconstruction,
          },
        });
      } catch (err) {
        // A concurrent run already wrote it: immutable, so theirs stands.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
      written += 1;
      if (isReconstruction) reconstructed += 1;
    }
    if (written > 0) console.log(`[learning] wrote ${written} edge book(s) (${reconstructed} reconstructed), version ${version}`);
    // The same book at the 5- and 20-session windows, from the rows already in
    // hand. Its failure must not hide the books just written from the caller.
    try {
      await refreshSignalTiming(db, rows, inputs);
    } catch (err) {
      console.error('[learning] signal timing failed:', err instanceof Error ? err.message : err);
    }
    return { version, written, reconstructed, latestAsOf: sessions[lastIdx] ?? null };
  });
}

// ─── Signal timing: the book at each grading window ──────────────────────────

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Node statistics rounded for storage (three books of them are kept in one row). */
function compactNodes(nodes: EdgeBook['nodes']): Record<string, NodeStats> {
  const out: Record<string, NodeStats> = {};
  for (const [key, s] of Object.entries(nodes)) {
    out[key] = { n: s.n, nEff: Number(s.nEff.toFixed(3)), excess: Number(s.excess.toFixed(4)) };
  }
  return out;
}

/**
 * Rebuild the latest session's edge book at every grading window and store
 * the three side by side (signal-timing.ts). Skipped when the stored row is
 * already for the latest session. `canonical` is the 10-session input set the
 * caller has already derived, so only the other two windows are derived here.
 */
export async function refreshSignalTiming(db: PrismaClient, rows: LearningRows, canonical: LearningInputs): Promise<boolean> {
  const lastIdx = rows.sessions.length - 1;
  const asOf = rows.sessions[lastIdx];
  if (asOf === undefined) return false;
  const { version } = canonical;
  const stored = await db.signalTiming.findUnique({ where: { version }, select: { asOf: true, combos: true } });
  if (stored && iso(stored.asOf) === asOf && stored.combos !== null) return false;

  const books: Record<string, Record<string, NodeStats>> = {};
  for (const h of TIMING_HORIZONS) {
    // One window at a time: each derivation holds every eligible stock-day.
    const inputs = h === canonical.params.horizon ? canonical : deriveLearningInputs(rows, { ...LEARNING_PARAMS, horizon: h });
    books[String(h)] = compactNodes(bookAt(inputs, lastIdx).nodes);
  }
  // Signals together (signal-combos.ts), on the canonical window's evidence and base rates.
  const base = buildBaseRates(canonical.days, lastIdx, canonical.minTickerDays, canonical.cohortOf);
  const combos = compactComboBook(
    buildComboBook(
      canonical.evidence.map((e) => ({ ...e, base: base(e.signalType, e.symbol, e.cell, e.direction) })),
      lastIdx,
      canonical.params.halfLifeSessions,
    ),
  );
  await db.$transaction([
    db.signalTiming.deleteMany({}), // other versions' rows mean nothing now
    db.signalTiming.create({
      data: {
        version,
        asOf: new Date(`${asOf}T00:00:00Z`),
        books: books as unknown as Prisma.InputJsonValue,
        combos: combos as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
  invalidateTimingBooks();
  console.log(`[learning] signal timing rebuilt at ${TIMING_HORIZONS.join('/')} sessions as of ${asOf}`);
  return true;
}

/**
 * Stamp the latest edge book's convictions onto the engine (current learning
 * version only — a book built under other definitions is never shown).
 * Returns how many flows changed. Clients pick the new values up on their next
 * flow update; convictions change once a night, so that lag is immaterial.
 */
export async function loadConvictionsIntoEngine(engine: FlowEngine): Promise<number> {
  const version = currentLearningVersion(await getAnalyticsConfig());
  const touched = await tryDb('load convictions', async (db) => {
    const latest = await db.edgeBook.findFirst({
      where: { version },
      orderBy: { asOf: 'desc' },
      select: { asOf: true, convictions: true },
    });
    if (!latest) return engine.setConvictions(new Map());
    return engine.setConvictions(parseConvictions(latest.convictions, latest.asOf.toISOString().slice(0, 10)));
  });
  return touched?.length ?? 0;
}

export interface LearningReport {
  version: string;
  generatedAt: string;
  status: {
    /** The trading-session clock: every day with an SPY close, including close-only backfill. */
    sessions: { first: string; last: string; count: number };
    /** Sessions the app actually captured (options data pinned at the close), not backfilled prices. */
    captured: { first: string | null; last: string | null; count: number };
    books: { total: number; live: number; reconstructed: number; latestAsOf: string | null };
    signals: {
      /** Single-name directional signals under the current definitions. */
      logged: number;
      /** Graded and usable as evidence. */
      graded: number;
      /** Window still open. */
      pending: number;
      /** Graded, but no base rate could be established (skipped, not guessed). */
      unbased: number;
      /** Skipped because they fired on, or were graded against, a frozen price. */
      excludedFrozen: number;
      /** Session the next pending signal's outcome becomes knowable (projected). */
      nextMaturity: string | null;
    };
    established: Record<Level, { established: number; total: number }> | null;
    frozen: { names: number; top: FrozenRun[] };
  };
  selfGrade: Calibration;
}

let reportCache: { key: string; at: number; report: LearningReport } | null = null;
const REPORT_TTL_MS = 30 * 60_000;

/**
 * Everything the learning page shows. Self-grading replays every past session
 * point-in-time, so the report is cached in memory for 30 minutes and keyed to
 * the latest book — a new nightly book invalidates it immediately.
 */
export async function getLearningReport(): Promise<LearningReport | null> {
  return tryDb('learning report', async (db) => {
    const cfg = await getAnalyticsConfig();
    const version = currentLearningVersion(cfg);
    const latest = await db.edgeBook.findFirst({ where: { version }, orderBy: { asOf: 'desc' } });
    const key = `${version}|${latest?.asOf.toISOString() ?? 'none'}`;
    if (reportCache && reportCache.key === key && Date.now() - reportCache.at < REPORT_TTL_MS) return reportCache.report;

    const inputs = await loadLearningInputs(db, undefined, cfg);
    if (!inputs) return null;
    const H = inputs.params.horizon;
    const { sessions } = inputs;
    const lastIdx = sessions.length - 1;

    let logged = 0;
    let pending = 0;
    let nextMaturityIdx = Infinity;
    for (const [idx, list] of inputs.activeBySession) {
      for (const s of list) {
        logged += 1;
        if (!s.scored) {
          pending += 1;
          nextMaturityIdx = Math.min(nextMaturityIdx, idx + H);
        }
      }
    }
    const [total, live, capturedDays] = await Promise.all([
      db.edgeBook.count({ where: { version } }),
      db.edgeBook.count({ where: { version, reconstructed: false } }),
      db.dailyMetric.groupBy({
        by: ['date'],
        where: finalizedMetricWhere({ historicalCloseOnly: false }),
        orderBy: { date: 'asc' },
      }),
    ]);

    const report: LearningReport = {
      version,
      generatedAt: new Date().toISOString(),
      status: {
        sessions: { first: sessions[0] ?? '', last: sessions[lastIdx] ?? '', count: sessions.length },
        captured: {
          first: capturedDays[0]?.date.toISOString().slice(0, 10) ?? null,
          last: capturedDays[capturedDays.length - 1]?.date.toISOString().slice(0, 10) ?? null,
          count: capturedDays.length,
        },
        books: { total, live, reconstructed: total - live, latestAsOf: latest ? latest.asOf.toISOString().slice(0, 10) : null },
        signals: {
          logged,
          graded: inputs.evidence.length,
          pending,
          unbased: latest?.rowsUnbased ?? 0,
          excludedFrozen: inputs.excludedFrozen,
          nextMaturity: Number.isFinite(nextMaturityIdx) ? projectSession(sessions, nextMaturityIdx) : null,
        },
        established: latest ? establishedCounts(bookFromRow(latest)) : null,
        frozen: { names: inputs.frozen.length, top: inputs.frozen.slice(0, 10) },
      },
      selfGrade: selfGrade(inputs).calibration,
    };
    reportCache = { key, at: Date.now(), report };
    return report;
  });
}

/** Session index → ET date, projecting past the last known session on the trading calendar. */
function projectSession(sessions: readonly string[], idx: number): string {
  if (idx < sessions.length) return sessions[idx]!;
  const d = new Date(`${sessions[sessions.length - 1]}T00:00:00Z`);
  let left = idx - (sessions.length - 1);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isTradingDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}
