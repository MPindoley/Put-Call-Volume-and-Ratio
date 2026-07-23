/**
 * Cohort-relative analytics orchestration (Phase 1).
 *
 * A COHORT is a peer group keyed by its benchmark ETF. Every tracked single
 * name belongs to exactly one cohort — its per-ticker benchmark override if it
 * has one (e.g. NVDA → SMH), otherwise its GICS sector SPDR (AAPL → XLK).
 * Membership is mutually exclusive: an overridden name leaves its GICS sector
 * median entirely. One name, one peer group.
 *
 * At the pinned end-of-day capture this module:
 *   1. writes finalized DailyMetric rows from live engine state,
 *   2. rolls finalized rows into per-COHORT cross-sectional aggregates
 *      (medians, benchmark values, IV-dispersion proxy, median-health IQR),
 *   3. computes per-ticker relative spreads (ticker − cohort median) and their
 *      30/90-day z-scores, plus a regime-detachment flag,
 *   4. surfaces the latest finalized values onto the engine for the UI.
 *
 * Discipline guarantees:
 *   • benchmark ETFs are excluded from every cohort's member set;
 *   • a cohort median is null below `minConstituents` (enforced AFTER override
 *     exits, so a thinned cohort returns null, never a thin median);
 *   • the IV-dispersion proxy stamps its weighting method (cap→OI→equal); a
 *     method change recomputes that cohort's series so no window mixes methods;
 *   • every median/relative-spread row is stamped with a `compositionVersion`
 *     (a hash of the cohort's defined membership + the membership-filter config);
 *     rolling windows and percentiles filter to the CURRENT version, so none
 *     ever spans two definitions — a composition change resets accumulation;
 *   • only finalized rows feed medians, windows and "accumulating N/90" counts;
 *   • all math is idempotent per date and missing-day safe.
 */
import type { PrismaClient } from '@prisma/client';
import type { FlowEngine } from './flow-engine';
import { getAnalyticsConfig, type AnalyticsConfig } from './analytics-config';
import { cohortLabel, listCohorts, loadBenchmarkResolver, type BenchmarkResolver } from './sector-benchmarks';
import { classifyDivergence, defaultInstrument, interpretDivergence } from './interpretation';
import { iqrBounds, linregSlope, median, percentileRank, quantile, slopeTStat, slopeTStatNW, weightedMean, zScoreGuarded } from './sector-stats';
import { TRACKED_UNIVERSE } from './universe';
import { tryDb } from './db';
import { finalizedMetricWhere } from './finalized-reads';
import { NOT_SEEDED } from './seed-guard';
import { etDateKey } from './trading-calendar';
import type { SectorRelative, SectorDispersion } from '@/types';

export type WeightMethod = 'cap' | 'oi' | 'equal';

interface Constituent {
  symbol: string;
  iv30: number | null;
  skew: number | null;
  oiPc: number | null;
  ivHv: number | null;
  totalOI: number | null;
  optVolume: number | null;
  cap: number | null;
}

// ─── Composition versioning ───────────────────────────────────────────────────

/** FNV-1a 32-bit hash → 8-hex string. Deterministic, dependency-free. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Version of a cohort's median DEFINITION: its defined membership (which names
 * map to it under the current benchmark config) plus the membership-filter
 * parameters. Changes only on an admin edit (universe, benchmark overrides, or
 * filter config) — not on the day-to-day filter outcome.
 */
export function compositionVersionFor(
  cohortKey: string,
  cohorts: Map<string, { label: string; members: string[] }>,
  cfg: AnalyticsConfig,
): string {
  const members = cohorts.get(cohortKey)?.members ?? [];
  const payload = `${members.join(',')}|iqr=${cfg.medianIqrMult}|oi=${cfg.medianMinOI}|vol=${cfg.medianMinVolume}`;
  return fnv1a(payload);
}

// ─── Pure compute helpers ─────────────────────────────────────────────────────

/**
 * Select which members contribute to a cohort's medians. Two configurable
 * filters: liquidity floors (`medianMinOI`/`medianMinVolume`, 0 = disabled) and
 * an IV outlier fence (`medianIqrMult`). Excluded names are returned too, with a
 * reason — they still receive a relative spread against the CLEANED median.
 */
export function selectMedianMembers(
  constituents: Constituent[],
  cfg: Pick<AnalyticsConfig, 'medianMinOI' | 'medianMinVolume' | 'medianIqrMult'>,
): { members: Constituent[]; excluded: { symbol: string; reason: string }[] } {
  const excluded: { symbol: string; reason: string }[] = [];
  const liquid = constituents.filter((c) => {
    if (cfg.medianMinOI > 0 && (c.totalOI ?? 0) < cfg.medianMinOI) {
      excluded.push({ symbol: c.symbol, reason: `OI ${Math.round(c.totalOI ?? 0)} < ${cfg.medianMinOI}` });
      return false;
    }
    if (cfg.medianMinVolume > 0 && (c.optVolume ?? 0) < cfg.medianMinVolume) {
      excluded.push({ symbol: c.symbol, reason: `vol ${Math.round(c.optVolume ?? 0)} < ${cfg.medianMinVolume}` });
      return false;
    }
    return true;
  });

  const bounds = iqrBounds(
    liquid.map((c) => c.iv30 ?? NaN).filter((v) => Number.isFinite(v)),
    cfg.medianIqrMult,
  );
  if (!bounds) return { members: liquid, excluded };

  const members = liquid.filter((c) => {
    if (c.iv30 === null) return true; // no IV → can't be an IV outlier; keep
    if (c.iv30 < bounds.lo || c.iv30 > bounds.hi) {
      excluded.push({ symbol: c.symbol, reason: `IV ${c.iv30.toFixed(1)} outside [${bounds.lo.toFixed(1)}, ${bounds.hi.toFixed(1)}]` });
      return false;
    }
    return true;
  });
  return { members, excluded };
}

/**
 * Resolve the dispersion weighting method: cap only when EVERY member has a
 * positive market cap (partial coverage would bias weights), else OI when every
 * member has positive OI, else equal.
 */
export function resolveWeightMethod(members: Constituent[]): WeightMethod {
  if (members.length === 0) return 'equal';
  if (members.every((c) => (c.cap ?? 0) > 0)) return 'cap';
  if (members.every((c) => (c.totalOI ?? 0) > 0)) return 'oi';
  return 'equal';
}

/** IV-dispersion proxy = benchmark IV30 ÷ weighted-mean member IV30. */
export function computeDispersion(
  benchmarkIv30: number | null,
  members: Constituent[],
  method: WeightMethod,
): number | null {
  if (benchmarkIv30 === null || benchmarkIv30 <= 0) return null;
  const withIv = members.filter((c) => (c.iv30 ?? 0) > 0);
  if (withIv.length === 0) return null;
  const ivs = withIv.map((c) => c.iv30 as number);
  const weights = withIv.map((c) => (method === 'cap' ? (c.cap ?? 0) : method === 'oi' ? (c.totalOI ?? 0) : 1));
  const wMean = weightedMean(ivs, weights);
  if (wMean === null || wMean <= 0) return null;
  return benchmarkIv30 / wMean;
}

/** Interquartile range of member IV30 — the median-health spread signal. */
function memberIqr(members: Constituent[]): number | null {
  const ivs = members.map((c) => c.iv30 ?? NaN).filter((v) => Number.isFinite(v));
  const q1 = quantile(ivs, 0.25);
  const q3 = quantile(ivs, 0.75);
  return q1 !== null && q3 !== null ? Number((q3 - q1).toFixed(2)) : null;
}

interface DailyRow {
  symbol: string;
  iv30: number | null;
  hv20: number | null;
  rrSkew: number | null;
  putOI: number | null;
  callOI: number | null;
  optVolume: number | null;
}

const DAILY_SELECT = {
  symbol: true,
  iv30: true,
  hv20: true,
  rrSkew: true,
  putOI: true,
  callOI: true,
  optVolume: true,
} as const;

function toConstituent(row: DailyRow, cap: number | null): Constituent {
  const oiPc = row.putOI !== null && row.callOI !== null && row.callOI > 0 ? row.putOI / row.callOI : null;
  const ivHv = row.iv30 !== null && row.hv20 !== null ? row.iv30 - row.hv20 : null;
  const totalOI = row.putOI !== null && row.callOI !== null ? row.putOI + row.callOI : null;
  return { symbol: row.symbol, iv30: row.iv30, skew: row.rrSkew, oiPc, ivHv, totalOI, optVolume: row.optVolume, cap };
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

export async function finalizeDailyCapture(engine: FlowEngine, now = new Date()): Promise<boolean> {
  const date = etDateKey(now);
  const config = await getAnalyticsConfig();
  const resolver = await loadBenchmarkResolver();
  const cohorts = listCohorts(resolver);

  const ok = await tryDb('finalize daily capture', async (db) => {
    const caps = await loadCaps(db);

    // 1. Pin finalized DailyMetric rows from live engine state.
    for (const flow of engine.allFlows()) {
      if (flow.lastUpdated === 0) continue;
      const priceTrend20 = await computePriceTrend(db, flow.symbol, date, flow.underlyingPrice);
      const optVolume = flow.sessionPutVolume + flow.sessionCallVolume;
      const data = {
        iv30: flow.iv30,
        hv20: flow.hv20,
        close: flow.underlyingPrice > 0 ? flow.underlyingPrice : null,
        putOI: flow.analytics ? flow.analytics.putOI : null,
        callOI: flow.analytics ? flow.analytics.callOI : null,
        rrSkew: flow.analytics?.rrSkew25 ?? null,
        optVolume: optVolume > 0 ? optVolume : null,
        priceTrend20,
        gex: flow.analytics?.gexPer1Pct ?? null,
        atmIvNear: flow.analytics?.atmIvNear ?? null,
        atmIvFar: flow.analytics?.atmIvFar ?? null,
        termSlope: flow.analytics?.termSlope ?? null,
        spikeBaselineDays: engine.detector.baselineSampleDays(flow.symbol),
        capturedEt: now,
        final: true,
        historicalCloseOnly: false,
      };
      await db.dailyMetric.upsert({
        where: { symbol_date: { symbol: flow.symbol, date } },
        create: { symbol: flow.symbol, date, ...data },
        update: data,
      });
    }

    // 2. Cohort aggregates from finalized rows for `date`.
    const finalRows = (await db.dailyMetric.findMany({
      where: finalizedMetricWhere({ date }),
      select: DAILY_SELECT,
    })) as DailyRow[];
    const rowBySymbol = new Map(finalRows.map((r) => [r.symbol, r]));

    for (const [cohortKey, def] of cohorts) {
      const constituents = finalRows
        .filter((r) => resolver.benchmarkFor(r.symbol) === cohortKey && !resolver.isBenchmark(r.symbol))
        .map((r) => toConstituent(r, caps.get(r.symbol) ?? null));
      const benchRow = rowBySymbol.get(cohortKey);
      const bench = benchRow ? toConstituent(benchRow, null) : null;

      const { members, excluded } = selectMedianMembers(constituents, config);
      if (excluded.length > 0) {
        console.log(
          `[cohort-analytics] ${def.label}: excluded ${excluded.length}/${constituents.length} from median — ` +
            excluded.map((e) => `${e.symbol}(${e.reason})`).join(', '),
        );
      }

      const version = compositionVersionFor(cohortKey, cohorts, config);
      const prior = await db.cohortDaily.findFirst({
        where: { cohort: cohortKey, final: true, ...NOT_SEEDED },
        orderBy: { date: 'desc' },
        select: { compositionVersion: true },
      });
      if (prior && prior.compositionVersion !== version) {
        console.log(`[cohort-analytics] ${def.label}: composition changed (${prior.compositionVersion}→${version}); rolling windows reset.`);
      }

      // minConstituents enforced AFTER the override exit — a thinned cohort → null.
      const enough = members.length >= config.minConstituents;
      const method = resolveWeightMethod(members);
      const dispersion = enough ? computeDispersion(bench?.iv30 ?? null, members, method) : null;

      const agg = {
        cohortLabel: def.label,
        final: true,
        constituentCount: members.length,
        medianIqr: enough ? memberIqr(members) : null,
        benchmarkIv30: bench?.iv30 ?? null,
        benchmarkSkew: bench?.skew ?? null,
        benchmarkOiPc: bench?.oiPc ?? null,
        benchmarkIvHv: bench?.ivHv ?? null,
        medianIv30: enough ? median(members.map((c) => c.iv30 ?? NaN)) : null,
        medianSkew: enough ? median(members.map((c) => c.skew ?? NaN)) : null,
        medianOiPc: enough ? median(members.map((c) => c.oiPc ?? NaN)) : null,
        medianIvHv: enough ? median(members.map((c) => c.ivHv ?? NaN)) : null,
        dispersionProxy: dispersion,
        dispersionWeightMethod: dispersion !== null ? method : null,
        compositionVersion: version,
      };
      await db.cohortDaily.upsert({
        where: { cohort_date: { cohort: cohortKey, date } },
        create: { cohort: cohortKey, date, ...agg },
        update: agg,
      });

      if (dispersion !== null) await ensureConsistentMethod(db, cohortKey, method, caps, config, resolver);
    }

    // 3. Per-ticker relative spreads (vs their OWN cohort median) + z + regime.
    const cohortToday = new Map(
      (await db.cohortDaily.findMany({ where: { date, final: true, ...NOT_SEEDED } })).map((s) => [s.cohort, s]),
    );
    for (const row of finalRows) {
      if (resolver.isBenchmark(row.symbol)) continue;
      const cohortKey = resolver.benchmarkFor(row.symbol);
      if (!cohortKey) continue;
      const cd = cohortToday.get(cohortKey);
      if (!cd) continue;
      const version = compositionVersionFor(cohortKey, cohorts, config);
      const c = toConstituent(row, caps.get(row.symbol) ?? null);
      const spreads = {
        ivRelSpread: rel(c.iv30, cd.medianIv30),
        skewRelSpread: rel(c.skew, cd.medianSkew),
        oiPcRelSpread: rel(c.oiPc, cd.medianOiPc),
        ivHvRelSpread: rel(c.ivHv, cd.medianIvHv),
      };
      // z-history filtered to the CURRENT composition version — never spans defs.
      const z = await computeZScores(db, row.symbol, date, version, spreads, config);
      const regime = detectRegimeDetach(z, config.regimeDetachSigma);
      // Divergence keys off the z-scored skew trend, never the raw spread level.
      const divergence = await computeDivergence(db, row.symbol, date, version, z.fields['skewZ30'] ?? null, config);

      await db.relativeMetric.upsert({
        where: { symbol_date: { symbol: row.symbol, date } },
        create: { symbol: row.symbol, date, cohort: cohortKey, compositionVersion: version, final: true, ...spreads, ...z.fields, windowDays: z.windowDays, ...regime, ...divergence },
        update: { cohort: cohortKey, compositionVersion: version, final: true, ...spreads, ...z.fields, windowDays: z.windowDays, ...regime, ...divergence },
      });
    }
    return true;
  });

  if (ok) await loadLatestIntoEngine(engine);
  return ok ?? false;
}

function rel(value: number | null, cohortMedian: number | null): number | null {
  return value !== null && cohortMedian !== null ? Number((value - cohortMedian).toFixed(4)) : null;
}

async function loadCaps(db: PrismaClient): Promise<Map<string, number>> {
  const rows = await db.marketCapConfig.findMany();
  return new Map(rows.filter((r) => r.marketCap > 0).map((r) => [r.symbol, r.marketCap]));
}

/** OLS slope of the trailing 20 finalized/historical closes including today. */
async function computePriceTrend(db: PrismaClient, symbol: string, date: Date, todayClose: number): Promise<number | null> {
  const prior = await db.dailyMetric.findMany({
    where: finalizedMetricWhere({ symbol, date: { lt: date }, close: { not: null } }),
    orderBy: { date: 'desc' },
    take: 19,
    select: { close: true },
  });
  const closes = [...prior.reverse().map((r) => r.close as number)];
  if (todayClose > 0) closes.push(todayClose);
  if (closes.length < 3) return null;
  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * ((closes[i] as number) - yMean);
    den += dx * dx;
  }
  return den === 0 ? null : Number((num / den).toFixed(5));
}

type RelField = 'ivRelSpread' | 'skewRelSpread' | 'oiPcRelSpread' | 'ivHvRelSpread';

const REL_TO_Z: Record<RelField, { z30: string; z90: string }> = {
  ivRelSpread: { z30: 'ivZ30', z90: 'ivZ90' },
  skewRelSpread: { z30: 'skewZ30', z90: 'skewZ90' },
  oiPcRelSpread: { z30: 'oiPcZ30', z90: 'oiPcZ90' },
  ivHvRelSpread: { z30: 'ivHvZ30', z90: 'ivHvZ90' },
};

/**
 * Guarded z-scores vs the symbol's own finalized rolling history, restricted to
 * rows sharing the CURRENT composition version. Below `zMinObs30`/`zMinObs90`
 * the score is null (accumulating); the stdev denominator is floored.
 */
async function computeZScores(
  db: PrismaClient,
  symbol: string,
  date: Date,
  version: string,
  today: Record<RelField, number | null>,
  cfg: AnalyticsConfig,
): Promise<{ fields: Record<string, number | null>; windowDays: number }> {
  const history = await db.relativeMetric.findMany({
    where: { symbol, date: { lt: date }, final: true, compositionVersion: version, ...NOT_SEEDED },
    orderBy: { date: 'desc' },
    take: cfg.z90Window,
    select: { ivRelSpread: true, skewRelSpread: true, oiPcRelSpread: true, ivHvRelSpread: true },
  });
  const fields: Record<string, number | null> = {};
  for (const key of Object.keys(REL_TO_Z) as RelField[]) {
    const value = today[key];
    const series = history.map((h) => h[key]).filter((v): v is number => v !== null);
    const map = REL_TO_Z[key];
    fields[map.z30] = value !== null ? zScoreGuarded(value, series.slice(0, cfg.z30Window), cfg.zMinObs30, cfg.zStdevFloor) : null;
    fields[map.z90] = value !== null ? zScoreGuarded(value, series.slice(0, cfg.z90Window), cfg.zMinObs90, cfg.zStdevFloor) : null;
  }
  return { fields, windowDays: Math.min(history.length, cfg.z90Window) };
}

/**
 * Divergence: 20-day price-trend sign vs 20-day skew-Z-trend sign. Reads the
 * z-scored skew relative spread (never the raw level), restricted to the current
 * composition version. Fires only when both trends are statistically nonflat
 * (|t| ≥ divergenceTStat) and point in opposite directions. The stored value is
 * RAW (data-based); the inverse flip is applied at surface time.
 */
async function computeDivergence(
  db: PrismaClient,
  symbol: string,
  date: Date,
  version: string,
  todaySkewZ30: number | null,
  cfg: AnalyticsConfig,
): Promise<{
  divergenceType: string | null;
  priceTrendSlope: number | null;
  priceTrendT: number | null;
  skewTrendSlope: number | null;
  skewTrendT: number | null;
  priceTrendTNW: number | null;
  skewTrendTNW: number | null;
  divergenceWindow: number;
}> {
  const empty = { divergenceType: null, priceTrendSlope: null, priceTrendT: null, skewTrendSlope: null, skewTrendT: null, priceTrendTNW: null, skewTrendTNW: null, divergenceWindow: 0 };

  // Skew-Z series (same composition version), most recent first → chronological.
  const priorZ = await db.relativeMetric.findMany({
    where: { symbol, date: { lt: date }, final: true, compositionVersion: version, skewZ30: { not: null }, ...NOT_SEEDED },
    orderBy: { date: 'desc' },
    take: cfg.divergenceWindow - 1,
    select: { skewZ30: true },
  });
  const skewSeries = priorZ.map((r) => r.skewZ30 as number).reverse();
  if (todaySkewZ30 !== null) skewSeries.push(todaySkewZ30);
  if (skewSeries.length < cfg.divergenceWindow) return { ...empty, divergenceWindow: skewSeries.length };

  // Price series over the same window (finalized closes only — includes today's, L2-1).
  const closeRows = await db.dailyMetric.findMany({
    where: finalizedMetricWhere({ symbol, date: { lte: date }, close: { not: null } }),
    orderBy: { date: 'desc' },
    take: cfg.divergenceWindow,
    select: { close: true },
  });
  const closes = closeRows.map((r) => r.close as number).reverse();
  if (closes.length < cfg.divergenceWindow) return { ...empty, divergenceWindow: skewSeries.length };

  const priceSlope = linregSlope(closes);
  const priceT = slopeTStat(closes);
  const skewSlope = linregSlope(skewSeries);
  const skewT = slopeTStat(skewSeries);
  // The OLS t is the (heuristic) screen; NW t is stored for audit only —
  // overlapping daily obs are autocorrelated, so the OLS t is not a real
  // significance test.
  const type = classifyDivergence({ slope: priceSlope, t: priceT }, { slope: skewSlope, t: skewT }, cfg.divergenceTStat);

  return {
    divergenceType: type,
    priceTrendSlope: round4(priceSlope),
    priceTrendT: round2s(priceT),
    skewTrendSlope: round4(skewSlope),
    skewTrendT: round2s(skewT),
    priceTrendTNW: round2s(slopeTStatNW(closes)),
    skewTrendTNW: round2s(slopeTStatNW(skewSeries)),
    divergenceWindow: skewSeries.length,
  };
}

function round4(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}
function round2s(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(2));
}

/** Regime detach: needs a non-null z90 (so it cannot fire below the 90-day minimum). */
function detectRegimeDetach(
  z: { fields: Record<string, number | null> },
  sigma: number,
): { regimeDetach: boolean; regimeDetachMetric: string | null; regimeDetachDir: string | null } {
  let best: { metric: string; z: number } | null = null;
  for (const [z30Key, z90Key, label] of [
    ['skewZ30', 'skewZ90', 'skew'],
    ['ivZ30', 'ivZ90', 'iv'],
    ['oiPcZ30', 'oiPcZ90', 'oiPc'],
    ['ivHvZ30', 'ivHvZ90', 'ivHv'],
  ] as const) {
    const z30 = z.fields[z30Key];
    const z90 = z.fields[z90Key];
    if (z30 === null || z30 === undefined || z90 === null || z90 === undefined) continue;
    if (Math.abs(z90) >= sigma && Math.sign(z30) === Math.sign(z90)) {
      if (!best || Math.abs(z90) > Math.abs(best.z)) best = { metric: label, z: z90 };
    }
  }
  if (!best) return { regimeDetach: false, regimeDetachMetric: null, regimeDetachDir: null };
  return { regimeDetach: true, regimeDetachMetric: best.metric, regimeDetachDir: best.z > 0 ? 'widening' : 'narrowing' };
}

/**
 * If the current weighting method differs from the cohort's most recent prior
 * finalized dispersion row, recompute the cohort's stored series under the new
 * method so history is single-method.
 */
async function ensureConsistentMethod(
  db: PrismaClient,
  cohortKey: string,
  method: WeightMethod,
  caps: Map<string, number>,
  cfgForRecompute: AnalyticsConfig,
  resolver: BenchmarkResolver,
): Promise<void> {
  const rows = await db.cohortDaily.findMany({
    where: { cohort: cohortKey, final: true, dispersionWeightMethod: { not: null }, ...NOT_SEEDED },
    orderBy: { date: 'asc' },
  });
  if (!rows.some((r) => r.dispersionWeightMethod !== null && r.dispersionWeightMethod !== method)) return;

  for (const r of rows) {
    const dayRows = (await db.dailyMetric.findMany({ where: finalizedMetricWhere({ date: r.date }), select: DAILY_SELECT })) as DailyRow[];
    const constituents = dayRows
      .filter((d) => resolver.benchmarkFor(d.symbol) === cohortKey && !resolver.isBenchmark(d.symbol))
      .map((d) => toConstituent(d, caps.get(d.symbol) ?? null))
      .filter((c) => (c.iv30 ?? 0) > 0);
    const { members } = selectMedianMembers(constituents, cfgForRecompute);
    const dispersion = computeDispersion(r.benchmarkIv30, members, method);
    await db.cohortDaily.update({
      where: { id: r.id },
      data: { dispersionProxy: dispersion, dispersionWeightMethod: dispersion !== null ? method : null },
    });
  }
  console.log(`[cohort-analytics] recomputed ${cohortKey} dispersion series under method='${method}'`);
}

/** Load the latest finalized cohort + relative values into the engine for the UI. */
export async function loadLatestIntoEngine(engine: FlowEngine): Promise<void> {
  const resolver = await loadBenchmarkResolver();
  const cohorts = listCohorts(resolver);
  const config = await getAnalyticsConfig();

  await tryDb('load latest cohort analytics', async (db) => {
    engine.sectorDispersion.clear();
    for (const [cohortKey, def] of cohorts) {
      const version = compositionVersionFor(cohortKey, cohorts, config);
      // Percentile window restricted to the current composition version.
      const rows = await db.cohortDaily.findMany({
        where: { cohort: cohortKey, final: true, compositionVersion: version, ...NOT_SEEDED },
        orderBy: { date: 'desc' },
        take: 90,
      });
      const latest = rows[0];
      if (!latest) continue;
      const dispSeries = rows.map((r) => r.dispersionProxy).filter((v): v is number => v !== null);
      const disp: SectorDispersion = {
        cohort: cohortKey,
        label: def.label,
        proxy: latest.dispersionProxy !== null ? Number(latest.dispersionProxy.toFixed(3)) : null,
        weightMethod: latest.dispersionWeightMethod,
        pct90: latest.dispersionProxy !== null ? percentileRank(latest.dispersionProxy, dispSeries) : null,
        sampleDays: rows.length,
        constituentCount: latest.constituentCount,
        medianIqr: latest.medianIqr,
        compositionVersion: version,
      };
      engine.sectorDispersion.set(cohortKey, disp);
    }

    // Latest finalized RelativeMetric per tracked ticker.
    const latestDate = (await db.relativeMetric.findFirst({ where: { final: true, ...NOT_SEEDED }, orderBy: { date: 'desc' }, select: { date: true } }))?.date;
    if (!latestDate) return;
    const relatives = await db.relativeMetric.findMany({ where: { date: latestDate, final: true, ...NOT_SEEDED } });
    engine.sectorRelatives.clear();
    for (const r of relatives) {
      const rel: SectorRelative = {
        symbol: r.symbol,
        cohort: r.cohort || null,
        cohortLabel: r.cohort ? cohortLabel(r.cohort, resolver.sectorBenchmarks) : null,
        skewZ30: nn(r.skewZ30),
        skewZ90: nn(r.skewZ90),
        ivZ30: nn(r.ivZ30),
        ivZ90: nn(r.ivZ90),
        oiPcZ30: nn(r.oiPcZ30),
        oiPcZ90: nn(r.oiPcZ90),
        ivHvZ30: nn(r.ivHvZ30),
        ivHvZ90: nn(r.ivHvZ90),
        windowDays: r.windowDays,
        regimeDetach: r.regimeDetach,
        regimeDetachMetric: r.regimeDetachMetric,
        regimeDetachDir: r.regimeDetachDir,
        // Inverse flip applied at surface time (raw stored value untouched).
        divergence: interpretDivergence(
          r.divergenceType === 'distribution' || r.divergenceType === 'accumulation' ? r.divergenceType : null,
          (engine.instruments.get(r.symbol) ?? defaultInstrument(r.symbol)).inverse,
        ),
        divergenceWindow: r.divergenceWindow,
        priceTrendT: r.priceTrendT,
        skewTrendT: r.skewTrendT,
        priceTrendTNW: r.priceTrendTNW,
        skewTrendTNW: r.skewTrendTNW,
      };
      engine.sectorRelatives.set(r.symbol, rel);
    }
  });
}

function nn(v: number | null): number | null {
  return v === null ? null : Number(v.toFixed(2));
}

/** Defined single-name count per cohort (for UI expectations / Sectors page). */
export function cohortDefinedCounts(resolver: BenchmarkResolver): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [cohort, def] of listCohorts(resolver)) counts.set(cohort, def.members.length);
  return counts;
}
