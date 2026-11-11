/**
 * Each name's own normal — I/O (own-normal.ts is the definition).
 *
 *  fillOwnPutCall         — stamp each pinned session's OI put/call percentile
 *                           against the name's own previous sessions onto its
 *                           row (DailyMetric.oiPcPct), in one statement.
 *  repairOwnPutCall       — daily: fill past sessions that have none (a new
 *                           column, imported history) and log the pc_own
 *                           signals those sessions would have fired.
 *  loadOwnRangesIntoEngine — each name's usual range, shown beside the live figure.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import { OWN_NORMAL, ownDirection, type OwnRange } from './own-normal';
import { logSignals } from './signal-jobs';

const DAY_MS = 86_400_000;
/** As far back as daily rows are kept. */
const HISTORY_DAYS = 400;

/** A pinned session row that carries open interest: what a percentile can be computed for and from. */
const WITH_OI = (alias: string): Prisma.Sql =>
  Prisma.raw(
    `${alias}."final" AND NOT ${alias}."seeded" AND NOT ${alias}."historicalCloseOnly" AND ${alias}."putOI" IS NOT NULL AND ${alias}."callOI" > 0`,
  );

/**
 * Fill oiPcPct on pinned rows dated `since` or later that have none: the row's
 * OI put/call ranked among the name's previous sessions (up to `lookback`),
 * left null when it has fewer than `minObs`. Previous sessions only, so the
 * value is the same whenever it is computed. Returns the sessions on which a
 * newly filled row sits outside the name's usual range (a pc_own signal).
 */
export async function fillOwnPutCall(db: PrismaClient, since: Date): Promise<Date[]> {
  const filled = await db.$queryRaw<{ date: Date; pct: number }[]>`
    UPDATE "DailyMetric" d
    SET "oiPcPct" = (x.below + 0.5 * x.ties) / x.n::double precision
    FROM "DailyMetric" b
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
             count(*) FILTER (WHERE p.pc < b."putOI" / b."callOI") AS below,
             count(*) FILTER (WHERE p.pc = b."putOI" / b."callOI") AS ties
      FROM (
        SELECT p0."putOI" / p0."callOI" AS pc
        FROM "DailyMetric" p0
        WHERE p0."symbol" = b."symbol" AND p0."date" < b."date" AND ${WITH_OI('p0')}
        ORDER BY p0."date" DESC
        LIMIT ${OWN_NORMAL.lookback}
      ) p
    ) x
    WHERE d."id" = b."id"
      AND ${WITH_OI('b')}
      AND b."date" >= ${since} AT TIME ZONE 'UTC'
      AND b."oiPcPct" IS NULL
      AND x.n >= ${OWN_NORMAL.minObs}
    RETURNING d."date" AS date, d."oiPcPct" AS pct
  `;
  const days = new Set<number>();
  for (const r of filled) if (ownDirection(r.pct) !== null) days.add(r.date.getTime());
  return [...days].sort((a, b) => a - b).map((t) => new Date(t));
}

export interface OwnRepairResult {
  /** Past sessions that gained a pc_own signal. */
  days: number;
  signals: number;
}

const repairTried = new Set<number>();

/**
 * Fill every stored session that has no own-percentile yet, and log the
 * pc_own signals the past ones would have fired (dated on their session;
 * `createdAt` records that they were logged late). Each past session is tried
 * once per process: signal logging is idempotent, but there is no reason to
 * repeat it.
 */
export async function repairOwnPutCall(now = new Date()): Promise<OwnRepairResult> {
  const out: OwnRepairResult = { days: 0, signals: 0 };
  const days = await tryDb('fill own put/call', (db) => fillOwnPutCall(db, new Date(now.getTime() - HISTORY_DAYS * DAY_MS)));
  for (const day of days ?? []) {
    if (repairTried.has(day.getTime())) continue;
    repairTried.add(day.getTime());
    // 20:00 UTC on the session date is that session's afternoon in ET.
    const logged = await logSignals(null, new Date(day.getTime() + 20 * 3_600_000));
    if (logged > 0) {
      out.days += 1;
      out.signals += logged;
    }
  }
  if (out.signals > 0) {
    console.log(
      `[own-normal] put/call-vs-own-range percentiles filled; ${out.signals} signals logged for ${out.days} past sessions`,
    );
  }
  return out;
}

/** Each name's usual OI put/call range over its recent sessions, onto the engine's rows. Returns how many names have one. */
export async function loadOwnRangesIntoEngine(engine: FlowEngine, now = new Date()): Promise<number> {
  const rows = await tryDb(
    'load own put/call ranges',
    (db) =>
      db.$queryRaw<{ symbol: string; n: number; lo: number; mid: number; hi: number }[]>`
      SELECT t."symbol",
             count(*)::int AS n,
             percentile_cont(0.05) WITHIN GROUP (ORDER BY t.pc) AS lo,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY t.pc) AS mid,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY t.pc) AS hi
      FROM (
        SELECT m."symbol", m."putOI" / m."callOI" AS pc,
               row_number() OVER (PARTITION BY m."symbol" ORDER BY m."date" DESC) AS rn
        FROM "DailyMetric" m
        WHERE ${WITH_OI('m')} AND m."date" >= ${new Date(now.getTime() - HISTORY_DAYS * DAY_MS)} AT TIME ZONE 'UTC'
      ) t
      WHERE t.rn <= ${OWN_NORMAL.lookback}
      GROUP BY t."symbol"
      HAVING count(*) >= ${OWN_NORMAL.minObs}
    `,
  );
  if (!rows) return 0;
  const round = (v: number): number => Number(v.toFixed(3));
  engine.setOwnPc(
    new Map<string, OwnRange>(rows.map((r) => [r.symbol, { lo: round(r.lo), mid: round(r.mid), hi: round(r.hi), n: r.n }])),
  );
  return rows.length;
}
