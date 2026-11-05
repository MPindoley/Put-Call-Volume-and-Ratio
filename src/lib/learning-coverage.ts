/**
 * Learning coverage: is every stock's data reaching every stage of the
 * learning, and how far along is each stage? One row per tracked stock, from a
 * handful of grouped queries, so it can be checked on the real database from
 * the Learning page.
 *
 * Stages, in the order data flows through them:
 *   capture     — pinned at each close (options data for that session)
 *   options     — IV, skew and open interest present on those captures
 *   sector      — sector-relative spreads and z-scores (need 20 / 60 sessions)
 *   signals     — directional signals logged and graded; the stock's own
 *                 record carries half the weight at LEARNING_PARAMS.prior.ticker
 *                 graded signals, its sector's and the market's before that
 *   projection  — realized vs implied moves (3 independent periods to use)
 *
 * Each stage is `ready`, `warming` (flowing, not enough yet), `problem` (data
 * that should be arriving is not) or `n/a` (ETFs are benchmarks: they have no
 * sector comparison and are kept out of directional learning).
 */
import type { PrismaClient } from '@prisma/client';
import { getAnalyticsConfig } from './analytics-config';
import type { FlowEngine } from './flow-engine';
import { LEARNING_PARAMS } from './learning';
import { MIN_PERIODS } from './projection-history';
import { regimeConfigVersion } from './regime';
import { loadBenchmarkResolver } from './sector-benchmarks';
import { DIRECTIONAL_SIGNALS, thresholdVersion } from './signals';
import { TRACKED_UNIVERSE } from './universe';

export const STAGES = ['capture', 'options', 'sector', 'signals', 'projection'] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = 'ready' | 'warming' | 'problem' | 'n/a';

/** Sessions looked at for gaps and data quality. */
export const RECENT_SESSIONS = 20;
/** Identical closes over this many captures = the stock has stopped trading. */
export const FROZEN_CAPTURES = 5;

export interface CoverageInput {
  symbol: string;
  sector: string;
  isEtf: boolean;
  /** In a sector peer group (has a benchmark to be compared against). */
  hasCohort: boolean;
  /** Sessions captured, all time. */
  captured: number;
  /** Sessions ago (0 = the latest captured session) of its first and last capture. */
  firstAgo: number | null;
  lastAgo: number | null;
  /** Captures within the last RECENT_SESSIONS sessions, and how many of those had IV, skew and OI. */
  recent: number;
  recentWithOptions: number;
  /** Its last FROZEN_CAPTURES captured closes are all identical. */
  frozen: boolean;
  /** Sector-relative rows with a spread, and with a 30- / 90-day z-score. */
  relRows: number;
  z30Rows: number;
  z90Rows: number;
  signalsLogged: number;
  signalsGraded: number;
  /** Independent periods behind the projection check; null before any. */
  projection: { week: number; month: number } | null;
}

export interface CoverageThresholds {
  zMinObs30: number;
  zMinObs90: number;
  /** Graded signals at which the stock's own record carries half the weight. */
  stockSignals: number;
  projectionPeriods: number;
}

/** Kinds of problem, most urgent first (the order the Learning page lists them). */
export const ISSUE_KINDS = ['stopped', 'gaps', 'options', 'sector', 'never'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_LABELS: Record<IssueKind, string> = {
  stopped: 'Stopped updating',
  gaps: 'Missing sessions',
  options: 'Options data incomplete',
  sector: 'Not reaching the sector comparison',
  never: 'Never captured',
};

export interface CoverageIssue {
  kind: IssueKind;
  text: string;
}

export interface StockCoverage extends CoverageInput {
  stages: Record<Stage, StageStatus>;
  issues: CoverageIssue[];
}

/** Pure: the stages and any problems for one stock. `sessions` = sessions the site has captured. */
export function classifyCoverage(c: CoverageInput, t: CoverageThresholds, sessions: number): StockCoverage {
  const issues: CoverageIssue[] = [];
  const add = (kind: IssueKind, text: string): void => {
    issues.push({ kind, text });
  };
  const stages = {} as Record<Stage, StageStatus>;

  // capture
  const window = Math.min(RECENT_SESSIONS, sessions);
  // A stock first captured recently is only expected on the sessions since then.
  const expected = c.firstAgo === null ? window : Math.min(window, c.firstAgo + 1);
  if (sessions === 0) {
    stages.capture = 'warming';
  } else if (c.captured === 0) {
    stages.capture = 'problem';
    add('never', 'never captured — no session has saved its options data');
  } else if (c.frozen) {
    stages.capture = 'problem';
    add('stopped', `price unchanged over its last ${FROZEN_CAPTURES} captures — it has probably stopped trading`);
  } else if (c.lastAgo !== null && c.lastAgo >= 5) {
    stages.capture = 'problem';
    add(
      'stopped',
      `not captured in the last ${c.lastAgo} sessions — it may have stopped trading, or the feed no longer serves it`,
    );
  } else if (expected >= 5 && c.recent < 0.8 * expected) {
    stages.capture = 'problem';
    add('gaps', `captured on ${c.recent} of the last ${expected} sessions`);
  } else {
    stages.capture = 'ready';
  }

  // options
  if (c.recent === 0) {
    stages.options = stages.capture === 'problem' ? 'problem' : 'warming';
  } else if (c.recent >= 5 && c.recentWithOptions < 0.5 * c.recent) {
    stages.options = 'problem';
    add('options', `IV, skew or open interest missing on ${c.recent - c.recentWithOptions} of its last ${c.recent} captures`);
  } else {
    stages.options = 'ready';
  }

  // sector
  if (c.isEtf) {
    stages.sector = 'n/a';
  } else if (!c.hasCohort) {
    stages.sector = 'problem';
    add('sector', 'no sector peer group (sector unknown) — left out of sector comparisons and sector-level learning');
  } else if (c.captured >= 5 && c.relRows === 0) {
    stages.sector = 'problem';
    add('sector', `${c.captured} captured sessions but no sector comparison rows`);
  } else if (c.relRows > t.zMinObs30 && c.z30Rows === 0) {
    stages.sector = 'problem';
    add('sector', `${c.relRows} sessions of sector spreads but no z-scores computed`);
  } else {
    stages.sector = c.relRows >= t.zMinObs90 ? 'ready' : 'warming';
  }

  // signals
  stages.signals = c.isEtf ? 'n/a' : c.signalsGraded >= t.stockSignals ? 'ready' : 'warming';

  // projection
  stages.projection = (c.projection?.week ?? 0) >= t.projectionPeriods ? 'ready' : 'warming';

  return { ...c, stages, issues };
}

export interface CoverageReport {
  generatedAt: string;
  sessions: { captured: number; latest: string | null };
  thresholds: CoverageThresholds & { recentSessions: number };
  /** Per stage: how many stocks are in each status. */
  stages: Record<Stage, Record<StageStatus, number>>;
  /** Stocks with problems, grouped by kind (most urgent first); a stock appears under each kind it has. */
  attention: { kind: IssueKind; label: string; stocks: { symbol: string; sector: string; text: string }[] }[];
}

/** Pure: roll per-stock rows up into the report. */
export function summarizeCoverage(
  rows: StockCoverage[],
  sessions: number,
  latest: string | null,
  t: CoverageThresholds,
): CoverageReport {
  const stages = Object.fromEntries(
    STAGES.map((s) => [s, { ready: 0, warming: 0, problem: 0, 'n/a': 0 } as Record<StageStatus, number>]),
  ) as Record<Stage, Record<StageStatus, number>>;
  for (const r of rows) for (const s of STAGES) stages[s][r.stages[s]] += 1;
  const attention = ISSUE_KINDS.map((kind) => ({
    kind,
    label: ISSUE_LABELS[kind],
    stocks: rows.flatMap((r) =>
      r.issues.filter((i) => i.kind === kind).map((i) => ({ symbol: r.symbol, sector: r.sector, text: i.text })),
    ),
  })).filter((g) => g.stocks.length > 0);
  return {
    generatedAt: new Date().toISOString(),
    sessions: { captured: sessions, latest },
    thresholds: { ...t, recentSessions: RECENT_SESSIONS },
    stages,
    attention,
  };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Every tracked stock's coverage, from the database (and the engine's projection calibrations). */
export async function loadCoverageRows(
  db: PrismaClient,
  engine: FlowEngine,
): Promise<{ rows: StockCoverage[]; sessions: number; latest: string | null; thresholds: CoverageThresholds }> {
  const cfg = await getAnalyticsConfig();
  const t: CoverageThresholds = {
    zMinObs30: cfg.zMinObs30,
    zMinObs90: cfg.zMinObs90,
    stockSignals: LEARNING_PARAMS.prior.ticker,
    projectionPeriods: MIN_PERIODS,
  };
  const tVersion = thresholdVersion(cfg);
  const rVersion = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });

  // The session clock: every date the site captured (close-only backfill excluded).
  const sessionRows = await db.$queryRaw<{ date: Date }[]>`
    SELECT DISTINCT "date" FROM "DailyMetric"
    WHERE "final" AND NOT "seeded" AND NOT "historicalCloseOnly"
    ORDER BY "date" DESC
  `;
  const ago = new Map(sessionRows.map((r, i) => [r.date.getTime(), i]));
  const recentStart = sessionRows[Math.min(RECENT_SESSIONS, sessionRows.length) - 1]?.date ?? new Date(0);

  const [captures, frozen, rels, signals] = await Promise.all([
    db.$queryRaw<{ symbol: string; captured: number; first: Date; last: Date; recent: number; recent_options: number }[]>`
      SELECT "symbol", count(*)::int AS captured, min("date") AS first, max("date") AS last,
             count(*) FILTER (WHERE "date" >= ${recentStart} AT TIME ZONE 'UTC')::int AS recent,
             count(*) FILTER (
               WHERE "date" >= ${recentStart} AT TIME ZONE 'UTC'
                 AND "iv30" IS NOT NULL AND "rrSkew" IS NOT NULL AND "putOI" IS NOT NULL AND "callOI" IS NOT NULL
             )::int AS recent_options
      FROM "DailyMetric"
      WHERE "final" AND NOT "seeded" AND NOT "historicalCloseOnly"
      GROUP BY "symbol"
    `,
    db.$queryRaw<{ symbol: string }[]>`
      SELECT "symbol" FROM (
        SELECT "symbol", "close", row_number() OVER (PARTITION BY "symbol" ORDER BY "date" DESC) AS rn
        FROM "DailyMetric"
        WHERE "final" AND NOT "seeded" AND NOT "historicalCloseOnly" AND "close" IS NOT NULL
      ) t
      WHERE rn <= ${FROZEN_CAPTURES}
      GROUP BY "symbol"
      HAVING count(*) = ${FROZEN_CAPTURES} AND count(DISTINCT "close") = 1
    `,
    db.$queryRaw<{ symbol: string; rel: number; z30: number; z90: number }[]>`
      SELECT "symbol", count("skewRelSpread")::int AS rel, count("skewZ30")::int AS z30, count("skewZ90")::int AS z90
      FROM "RelativeMetric"
      WHERE "final" AND NOT "seeded"
      GROUP BY "symbol"
    `,
    db.$queryRaw<{ symbol: string; logged: number; graded: number }[]>`
      SELECT "symbol", count(*)::int AS logged, count(*) FILTER (WHERE "scored")::int AS graded
      FROM "SignalLog"
      WHERE NOT "seeded" AND NOT "isEtf" AND "direction" IN ('bullish', 'bearish')
        AND "signalType" = ANY(${[...DIRECTIONAL_SIGNALS]})
        AND "thresholdVersion" = ${tVersion} AND "regimeConfigVersion" = ${rVersion}
      GROUP BY "symbol"
    `,
  ]);
  const capBy = new Map(captures.map((r) => [r.symbol, r]));
  const frozenSet = new Set(frozen.map((r) => r.symbol));
  const relBy = new Map(rels.map((r) => [r.symbol, r]));
  const sigBy = new Map(signals.map((r) => [r.symbol, r]));
  const resolver = await loadBenchmarkResolver();

  const rows = TRACKED_UNIVERSE.map(({ symbol, sector }) => {
    const cap = capBy.get(symbol);
    const rel = relBy.get(symbol);
    const sig = sigBy.get(symbol);
    const cal = engine.calibrations.get(symbol);
    const isEtf = sector === 'ETF' || resolver.isBenchmark(symbol);
    return classifyCoverage(
      {
        symbol,
        sector,
        isEtf,
        hasCohort: resolver.benchmarkFor(symbol) !== null,
        captured: cap?.captured ?? 0,
        firstAgo: cap ? (ago.get(cap.first.getTime()) ?? null) : null,
        lastAgo: cap ? (ago.get(cap.last.getTime()) ?? null) : null,
        recent: cap?.recent ?? 0,
        recentWithOptions: cap?.recent_options ?? 0,
        frozen: frozenSet.has(symbol),
        relRows: rel?.rel ?? 0,
        z30Rows: rel?.z30 ?? 0,
        z90Rows: rel?.z90 ?? 0,
        signalsLogged: sig?.logged ?? 0,
        signalsGraded: sig?.graded ?? 0,
        projection: cal ? { week: cal.week.ticker.periods, month: cal.month.ticker.periods } : null,
      },
      t,
      sessionRows.length,
    );
  });
  return { rows, sessions: sessionRows.length, latest: sessionRows[0] ? iso(sessionRows[0].date) : null, thresholds: t };
}
