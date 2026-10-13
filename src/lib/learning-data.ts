/**
 * Turns stored history into learning inputs (learning.ts is the pure math).
 *
 * Everything here mirrors the accuracy matrix's definitions (matrix-data.ts) so
 * the learning loop and the matrix can never disagree about what counts:
 *  - directional signals on SINGLE NAMES only (ETF flow is hedging, DECISIONS);
 *  - only rows under the CURRENT thresholdVersion + regimeConfigVersion;
 *  - FINAL closes only (finalizedMetricWhere), never a provisional intraday row;
 *  - base-rate denominators from the shared eligibility rules in signals.ts.
 * Sectors come from the resolver's persisted-sector fallback, so names removed
 * from the universe keep their history in the right place.
 */
import { getAnalyticsConfig, type AnalyticsConfig } from './analytics-config';
import type { PrismaClient } from '@prisma/client';
import { finalizedMetricWhere } from './finalized-reads';
import type { TickerConviction } from '@/types';
import {
  buildBaseRates,
  buildEdgeBook,
  combineConviction,
  CONVICTION_DISPLAY_FLOOR,
  estimateEdge,
  LEARNING_PARAMS,
  learningVersion,
  type Conviction,
  type DayObs,
  type EdgeBook,
  type Evidence,
  type LearningParams,
  type SignalKey,
} from './learning';
import { regimeConfigVersion } from './regime';
import { loadBenchmarkResolver } from './sector-benchmarks';
import { NOT_SEEDED } from './seed-guard';
import { TERMINAL_QUIET_SESSIONS } from './signal-jobs';
import {
  DIRECTIONAL_SIGNALS,
  eligibleFromMetric,
  eligibleFromRelative,
  thresholdVersion,
  type Direction,
} from './signals';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** A graded signal before its base rate is attached (that depends on the book date). */
export interface RawEvidence extends Omit<Evidence, 'base'> {
  /** Full regime triple for the base-rate lookup (matrix rule). */
  cell: string;
  /** The forward excess return it was graded on. */
  ret: number;
}

/** A signal live on a session, with what's needed to grade a forecast built from it. */
export interface ActiveSignal extends SignalKey {
  cell: string;
  /** Forward return on the learning basis/horizon, once graded (null until then). */
  ret: number | null;
}

export interface LearningInputs {
  version: string;
  params: LearningParams;
  sessions: string[];
  evidence: RawEvidence[];
  days: DayObs[];
  /** Signals fired per session index (single names, current versions, scored or not). */
  activeBySession: Map<number, ActiveSignal[]>;
  minTickerDays: number;
  cohortOf: (symbol: string) => string | null;
}

/** Reads every input the learning loop needs in one pass. Null when there are no sessions. */
export async function loadLearningInputs(
  db: PrismaClient,
  params: LearningParams = LEARNING_PARAMS,
  cfgIn?: AnalyticsConfig,
): Promise<LearningInputs | null> {
  const cfg = cfgIn ?? (await getAnalyticsConfig());
  const tVersion = thresholdVersion(cfg);
  const rVersion = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });
  const H = params.horizon;
  const retField = `fwd${H}${params.basis === 'raw' ? 'Raw' : params.basis === 'exSpy' ? 'ExSpy' : 'ExSector'}`;

  // ── Canonical sessions and regimes ──
  const spyRows = await db.dailyMetric.findMany({
    where: finalizedMetricWhere({ symbol: 'SPY', close: { not: null } }),
    orderBy: { date: 'asc' },
    select: { date: true, close: true },
  });
  if (spyRows.length === 0) return null;
  const sessions = spyRows.map((r) => iso(r.date));
  const sessionIdx = new Map(sessions.map((d, i) => [d, i]));
  const lastIdx = sessions.length - 1;
  const regimes = await db.dailyRegime.findMany({ where: { final: true, ...NOT_SEEDED } });
  const cellByDate = new Map(regimes.map((r) => [iso(r.date), `${r.volState}|${r.trendState}|${r.gammaState ?? 'na'}`]));

  const resolver = await loadBenchmarkResolver();
  const isEtf = (symbol: string, flag = false): boolean => flag || resolver.sectorFor(symbol) === 'ETF';
  const cohortOf = (symbol: string): string | null => resolver.benchmarkFor(symbol);

  // ── Signals: evidence (graded) and active (per session) ──
  const signals = await db.signalLog.findMany({
    where: {
      ...NOT_SEEDED,
      signalType: { in: [...DIRECTIONAL_SIGNALS] },
      direction: { in: ['bullish', 'bearish'] },
      thresholdVersion: tVersion,
      regimeConfigVersion: rVersion,
    },
  });
  const evidence: RawEvidence[] = [];
  const activeBySession = new Map<number, ActiveSignal[]>();
  for (const r of signals) {
    if (isEtf(r.symbol, r.isEtf)) continue;
    const firedIdx = sessionIdx.get(iso(r.firedOn));
    if (firedIdx === undefined) continue;
    const key: SignalKey = {
      signalType: r.signalType,
      direction: r.direction as Direction,
      regime: `${r.regimeVol ?? 'na'}|${r.regimeTrend ?? 'na'}`,
      sector: resolver.sectorFor(r.symbol),
      symbol: r.symbol,
    };
    const cell = `${r.regimeVol ?? 'na'}|${r.regimeTrend ?? 'na'}|${r.regimeGamma ?? 'na'}`;
    const ret = r.scored ? ((r as unknown as Record<string, number | null>)[retField] ?? null) : null;

    const list = activeBySession.get(firedIdx) ?? [];
    list.push({ ...key, cell, ret });
    activeBySession.set(firedIdx, list);

    if (ret === null) continue;
    // Knowable at the scheduled endpoint — or, for a name that stopped trading,
    // only once it had been silent long enough to be called terminal.
    let knownIdx = firedIdx + H;
    if (r.terminalOn) {
      const t = sessionIdx.get(iso(r.terminalOn));
      if (t !== undefined) knownIdx = Math.max(knownIdx, t + TERMINAL_QUIET_SESSIONS);
    }
    evidence.push({
      ...key,
      cell,
      firedIdx,
      knownIdx,
      hit: r.direction === 'bullish' ? ret > 0 : ret < 0,
      ret,
    });
  }

  // ── Base-rate day observations (matrix rules, point-in-time stamped) ──
  const dms = await db.dailyMetric.findMany({
    where: finalizedMetricWhere(),
    select: {
      symbol: true,
      date: true,
      close: true,
      putOI: true,
      callOI: true,
      spikeBaselineDays: true,
      historicalCloseOnly: true,
    },
  });
  const rels = await db.relativeMetric.findMany({
    where: { final: true, ...NOT_SEEDED },
    select: { symbol: true, date: true, skewZ30: true, divergenceWindow: true },
  });
  const closes = new Map<string, Map<string, number>>();
  for (const r of dms) {
    if (r.close === null) continue;
    const m = closes.get(r.symbol) ?? new Map<string, number>();
    m.set(iso(r.date), r.close);
    closes.set(r.symbol, m);
  }
  const logRet = (m: Map<string, number> | undefined, from: string, to: string): number | null => {
    const a = m?.get(from);
    const b = m?.get(to);
    return a && b && a > 0 && b > 0 ? Math.log(b / a) : null;
  };
  const fwdRet = (symbol: string, i: number): number | null => {
    if (i + H > lastIdx) return null;
    const d = sessions[i]!;
    const dh = sessions[i + H]!;
    const raw = logRet(closes.get(symbol), d, dh);
    if (raw === null || params.basis === 'raw') return raw;
    const bench = params.basis === 'exSpy' ? 'SPY' : cohortOf(symbol);
    if (!bench || bench === symbol) return null;
    const b = logRet(closes.get(bench), d, dh);
    return b === null ? null : raw - b;
  };

  const days: DayObs[] = [];
  const addDay = (type: string, symbol: string, d: string): void => {
    if (isEtf(symbol)) return;
    const i = sessionIdx.get(d);
    const cell = cellByDate.get(d);
    if (i === undefined || cell === undefined) return;
    const ret = fwdRet(symbol, i);
    if (ret === null) return;
    days.push({ type, symbol, cell, knownIdx: i + H, ret });
  };
  for (const r of dms) {
    if (r.historicalCloseOnly) continue;
    for (const type of eligibleFromMetric(r)) addDay(type, r.symbol, iso(r.date));
  }
  for (const r of rels) {
    for (const type of eligibleFromRelative(r, cfg.divergenceWindow)) addDay(type, r.symbol, iso(r.date));
  }

  return {
    version: learningVersion(params, tVersion, rVersion),
    params,
    sessions,
    evidence,
    days,
    activeBySession,
    minTickerDays: cfg.baseRateMinTickerDays,
    cohortOf,
  };
}

/** The learning version in force under the current analytics config (cheap; no data reads). */
export function currentLearningVersion(cfg: AnalyticsConfig, params: LearningParams = LEARNING_PARAMS): string {
  return learningVersion(
    params,
    thresholdVersion(cfg),
    regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    }),
  );
}

/** Rehydrate a stored EdgeBook row into the pure structure (asOfIdx is not stored). */
export function bookFromRow(row: { version: string; nodes: unknown; rowsUsed: number; rowsUnbased: number }): EdgeBook {
  return {
    version: row.version,
    asOfIdx: -1,
    params: LEARNING_PARAMS,
    nodes: (row.nodes ?? {}) as EdgeBook['nodes'],
    rowsUsed: row.rowsUsed,
    rowsUnbased: row.rowsUnbased,
  };
}

/** The edge book as of session index `asOfIdx`, with base rates as known then. */
export function bookAt(inputs: LearningInputs, asOfIdx: number): EdgeBook {
  const base = buildBaseRates(inputs.days, asOfIdx, inputs.minTickerDays, inputs.cohortOf);
  const evidence: Evidence[] = inputs.evidence
    .filter((e) => e.knownIdx <= asOfIdx)
    .map((e) => ({ ...e, base: base(e.signalType, e.symbol, e.cell, e.direction) }));
  return buildEdgeBook(evidence, asOfIdx, inputs.version, inputs.params);
}

/** Per-ticker conviction for every name with a signal on session `asOfIdx`. */
export function convictionsAt(inputs: LearningInputs, book: EdgeBook, asOfIdx: number): Map<string, Conviction> {
  const bySymbol = new Map<string, SignalKey[]>();
  for (const a of inputs.activeBySession.get(asOfIdx) ?? []) {
    const list = bySymbol.get(a.symbol) ?? [];
    list.push(a);
    bySymbol.set(a.symbol, list);
  }
  const out = new Map<string, Conviction>();
  for (const [symbol, keys] of bySymbol) out.set(symbol, combineConviction(book, keys));
  return out;
}

/** Compact JSON for EdgeBook.convictions: { SYM: { s, p: [[type, dir, edge, n]] } }. */
export function serializeConvictions(convictions: Map<string, Conviction>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [symbol, c] of convictions) {
    out[symbol] = {
      s: Number(c.score.toFixed(5)),
      p: c.parts.map((p) => [p.signalType, p.direction, Number(p.edge.toFixed(5)), p.n]),
    };
  }
  return out;
}

/**
 * Inverse of serializeConvictions → what the engine stamps onto each flow.
 * Malformed entries are skipped, never guessed; a net below the display floor
 * keeps its score but gets direction null (the UI shows "—").
 */
export function parseConvictions(json: unknown, asOf: string): Map<string, TickerConviction> {
  const out = new Map<string, TickerConviction>();
  if (!json || typeof json !== 'object') return out;
  for (const [symbol, raw] of Object.entries(json as Record<string, unknown>)) {
    const v = raw as { s?: unknown; p?: unknown };
    if (typeof v?.s !== 'number' || !Number.isFinite(v.s) || !Array.isArray(v.p)) continue;
    const parts: TickerConviction['parts'] = [];
    for (const p of v.p) {
      if (!Array.isArray(p) || p.length < 4) continue;
      const [signalType, direction, edge, n] = p as [unknown, unknown, unknown, unknown];
      if (typeof signalType !== 'string' || (direction !== 'bullish' && direction !== 'bearish')) continue;
      if (typeof edge !== 'number' || typeof n !== 'number') continue;
      parts.push({ signalType, direction, edge, n });
    }
    const thin = Math.abs(v.s) < CONVICTION_DISPLAY_FLOOR;
    out.set(symbol, { score: v.s, direction: thin ? null : v.s > 0 ? 'bullish' : 'bearish', asOf, parts });
  }
  return out;
}

/** One stock's memory: its own graded signals, and how today's learned edges were built. */
export interface TrackRecord {
  horizon: number;
  basis: string;
  /** This stock's OWN record per signal (unshrunk, raw hit rate), current definitions. */
  bySignal: {
    signalType: string;
    direction: Direction;
    graded: number;
    hits: number;
    hitRate: number | null;
    avgRet: number | null;
  }[];
  /** Most recent signals, newest first; `pending` = window not elapsed yet. */
  recent: {
    firedOn: string;
    signalType: string;
    direction: Direction;
    ret: number | null;
    hit: boolean | null;
    terminalOn: string | null;
    pending: boolean;
  }[];
  /** For each signal in the latest book's session: the shrinkage path, level by level. */
  learned: {
    signalType: string;
    direction: Direction;
    asOf: string;
    edge: number;
    path: { level: string; n: number; raw: number | null; edge: number; evidence: number }[];
  }[];
  /** Why `learned` may be empty: no book yet, or an ETF (reference only, never learned from). */
  note: string | null;
}

export async function loadTrackRecord(
  db: PrismaClient,
  symbol: string,
  cfgIn?: AnalyticsConfig,
): Promise<TrackRecord> {
  const cfg = cfgIn ?? (await getAnalyticsConfig());
  const params = LEARNING_PARAMS;
  const tVersion = thresholdVersion(cfg);
  const rVersion = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });
  const retField = `fwd${params.horizon}${params.basis === 'raw' ? 'Raw' : params.basis === 'exSpy' ? 'ExSpy' : 'ExSector'}`;
  const rows = await db.signalLog.findMany({
    where: {
      symbol,
      ...NOT_SEEDED,
      signalType: { in: [...DIRECTIONAL_SIGNALS] },
      direction: { in: ['bullish', 'bearish'] },
      thresholdVersion: tVersion,
      regimeConfigVersion: rVersion,
    },
    orderBy: { firedOn: 'desc' },
  });

  const groups = new Map<string, { graded: number; hits: number; sum: number }>();
  const recent: TrackRecord['recent'] = [];
  for (const r of rows) {
    const dir = r.direction as Direction;
    const ret = r.scored ? ((r as unknown as Record<string, number | null>)[retField] ?? null) : null;
    const hit = ret === null ? null : dir === 'bullish' ? ret > 0 : ret < 0;
    if (recent.length < 40) {
      recent.push({
        firedOn: iso(r.firedOn),
        signalType: r.signalType,
        direction: dir,
        ret,
        hit,
        terminalOn: r.terminalOn ? iso(r.terminalOn) : null,
        pending: !r.scored,
      });
    }
    if (ret === null) continue;
    const k = `${r.signalType}|${dir}`;
    const g = groups.get(k) ?? { graded: 0, hits: 0, sum: 0 };
    g.graded += 1;
    if (hit) g.hits += 1;
    g.sum += ret;
    groups.set(k, g);
  }
  const bySignal: TrackRecord['bySignal'] = [...groups.entries()].map(([k, g]) => {
    const [signalType, direction] = k.split('|') as [string, Direction];
    return {
      signalType,
      direction,
      graded: g.graded,
      hits: g.hits,
      hitRate: g.graded > 0 ? g.hits / g.graded : null,
      avgRet: g.graded > 0 ? g.sum / g.graded : null,
    };
  });

  const resolver = await loadBenchmarkResolver();
  const sector = resolver.sectorFor(symbol);
  const learned: TrackRecord['learned'] = [];
  let note: string | null = null;
  if (sector === 'ETF') {
    note = 'ETF flow is structural hedging, not a directional bet — logged for reference, never learned from.';
  } else {
    const latest = await db.edgeBook.findFirst({
      where: { version: currentLearningVersion(cfg) },
      orderBy: { asOf: 'desc' },
    });
    if (!latest) {
      note = 'No edge book yet — nothing has been graded under the current signal definitions.';
    } else {
      const book = bookFromRow(latest);
      const asOf = iso(latest.asOf);
      for (const r of rows.filter((x) => iso(x.firedOn) === asOf)) {
        const est = estimateEdge(book, {
          signalType: r.signalType,
          direction: r.direction as Direction,
          regime: `${r.regimeVol ?? 'na'}|${r.regimeTrend ?? 'na'}`,
          sector,
          symbol,
        });
        learned.push({
          signalType: r.signalType,
          direction: r.direction as Direction,
          asOf,
          edge: est.edge,
          path: est.path.map((p) => ({ level: p.level, n: p.n, raw: p.raw, edge: p.edge, evidence: p.evidence })),
        });
      }
    }
  }
  return { horizon: params.horizon, basis: params.basis, bySignal, recent, learned, note };
}
