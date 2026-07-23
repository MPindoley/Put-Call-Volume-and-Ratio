/**
 * Phase 4.4: assemble the regime-conditional accuracy matrix from stored,
 * immutable inputs (SignalLog, DailyRegime, DailyMetric, RelativeMetric).
 *
 * Base rates are REGIME-MATCHED: each signal row's no-skill hit probability is
 * measured over all days its ticker was ELIGIBLE to fire that signal within the
 * same regime cell — signal or not — so the matrix doesn't just rediscover that
 * stocks behave differently in backwardation. The all-period unconditional base
 * is also computed for reference. Eligibility is reconstructed point-in-time from
 * persisted daily state (skewZ30/divergenceWindow on RelativeMetric; putOI/callOI,
 * spikeBaselineDays on DailyMetric) under the current threshold version. Below
 * `baseRateMinTickerDays` in-regime days the ticker's cohort is pooled instead,
 * and each cell labels which denominator it used.
 *
 * Only rows stamped with the CURRENT thresholdVersion and regimeConfigVersion
 * enter the matrix (no window spans two definitions); excluded counts are
 * reported. Statistical honesty: Wilson CIs, cells-tested count, and the number
 * of cells expected to clear |z|≥1.96 by chance ride along with the result.
 */
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import { regimeConfigVersion } from './regime';
import { loadBenchmarkResolver } from './sector-benchmarks';
import { NOT_SEEDED } from './seed-guard';
import {
  baseHitProb,
  buildMatrix,
  DIRECTIONAL_SIGNALS,
  eventTrackSummary,
  mergeCounts,
  thresholdVersion,
  type DayCounts,
  type Direction,
  type MatrixResult,
  type MatrixRow,
} from './signals';
import { isTradingDay } from './trading-calendar';
import { sectorOf } from './universe';

export type Horizon = 5 | 10 | 20;
export type Basis = 'exSpy' | 'exSector' | 'raw';

export interface RegimeMatrixData {
  warming: boolean;
  signalsLogged: number;
  signalsScored: number;
  /** ET ISO date the first logged signal becomes scoreable (warming state). */
  firstScoringDate: string | null;
  horizon: Horizon;
  basis: Basis;
  matrix: MatrixResult | null;
  excludedByVersion: number;
  thresholdVersion: string;
  regimeConfigVersion: string;
  /** First date with the full regime triple (gamma available); earlier signals are 2-D. */
  fullTripleFrom: string | null;
  eventTrack: ReturnType<typeof eventTrackSummary> | null;
  /// Grouped by PRIMARY curve-shape resolution; secondary outcome counts and the
  /// classification-method split (components vs proxy) nested — never silently mixed.
  backwardation: {
    resolution: string;
    n: number;
    avgCumReturnPct: number;
    outcomes: Record<string, number>;
    methods: Record<string, number>;
  }[];
  backwardationOpen: number;
  regimeDetachLogged: number;
  /// ETF directional signals — logged for reference, never in the matrix (hedging flow).
  etfTrack: { signalType: string; n: number; hits: number; hitRate: number; avgRet: number }[];
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Walk forward n trading days from an ET date (calendar-based projection). */
function addTradingDays(fromIso: string, n: number): string {
  const d = new Date(`${fromIso}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isTradingDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) left -= 1;
  }
  return iso(d);
}

export async function buildRegimeMatrixData(horizon: Horizon, basis: Basis): Promise<RegimeMatrixData | null> {
  const cfg = await getAnalyticsConfig();
  const tVersion = thresholdVersion(cfg);
  const rVersion = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });

  return tryDb('regime matrix', async (db) => {
    const all = await db.signalLog.findMany({ where: { ...NOT_SEEDED } });
    const scored = all.filter((r) => r.scored);
    const firstGamma = await db.dailyRegime.findFirst({
      where: { gammaState: { not: null }, ...NOT_SEEDED },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    const base: Omit<RegimeMatrixData, 'matrix' | 'eventTrack' | 'backwardation' | 'backwardationOpen' | 'etfTrack'> = {
      warming: scored.length === 0,
      signalsLogged: all.length,
      signalsScored: scored.length,
      firstScoringDate: null,
      horizon,
      basis,
      excludedByVersion: 0,
      thresholdVersion: tVersion,
      regimeConfigVersion: rVersion,
      fullTripleFrom: firstGamma ? iso(firstGamma.date) : null,
      regimeDetachLogged: all.filter((r) => r.signalType === 'regime_detach').length,
    };

    // Backwardation summary: PRIMARY curve-shape resolution × episode return,
    // with the secondary outcome classes nested under each.
    const closed = await db.backwardationEpisode.findMany({ where: { endDate: { not: null }, ...NOT_SEEDED } });
    const byRes = new Map<string, { n: number; sum: number; outcomes: Record<string, number>; methods: Record<string, number> }>();
    for (const e of closed) {
      const k = e.resolution ?? 'unknown';
      const s = byRes.get(k) ?? { n: 0, sum: 0, outcomes: {}, methods: {} };
      s.n += 1;
      s.sum += e.cumReturn ?? 0;
      const o = e.outcome ?? 'unknown';
      s.outcomes[o] = (s.outcomes[o] ?? 0) + 1;
      const m = e.resolutionMethod ?? 'unknown';
      s.methods[m] = (s.methods[m] ?? 0) + 1;
      byRes.set(k, s);
    }
    const backwardation = [...byRes.entries()].map(([resolution, s]) => ({
      resolution,
      n: s.n,
      avgCumReturnPct: Number(((s.sum / s.n) * 100).toFixed(2)),
      outcomes: s.outcomes,
      methods: s.methods,
    }));
    const backwardationOpen = await db.backwardationEpisode.count({ where: { endDate: null, ...NOT_SEEDED } });

    if (scored.length === 0) {
      const earliest = all.reduce<Date | null>((min, r) => (min === null || r.firedOn < min ? r.firedOn : min), null);
      return {
        ...base,
        firstScoringDate: earliest ? addTradingDays(iso(earliest), 20) : null,
        matrix: null,
        eventTrack: null,
        backwardation,
        backwardationOpen,
        etfTrack: [],
      };
    }

    // ── Canonical sessions + regime lookup ──
    const spyRows = await db.dailyMetric.findMany({
      where: { symbol: 'SPY', close: { not: null }, ...NOT_SEEDED },
      orderBy: { date: 'asc' },
      select: { date: true, close: true },
    });
    const sessions = spyRows.map((r) => iso(r.date));
    const sessionIdx = new Map(sessions.map((d, i) => [d, i]));
    const lastIdx = sessions.length - 1;
    const regimes = await db.dailyRegime.findMany({ where: { final: true, ...NOT_SEEDED } });
    const regimeByDate = new Map(
      regimes.map((r) => [iso(r.date), { vol: r.volState, trend: r.trendState, gamma: r.gammaState }]),
    );
    const cellOf = (d: string): string | null => {
      const r = regimeByDate.get(d);
      return r ? `${r.vol}|${r.trend}|${r.gamma ?? 'na'}` : null;
    };

    // ── Directional rows under the current versions — SINGLE NAMES ONLY. ETF/index
    // flow is structurally hedging; ETF rows route to their own reference track.
    // (sectorOf fallback self-heals rows logged before the isEtf flag existed.)
    const isEtfRow = (r: { isEtf: boolean; symbol: string }): boolean => r.isEtf || sectorOf(r.symbol) === 'ETF';
    const allDirectional = scored.filter(
      (r) =>
        (DIRECTIONAL_SIGNALS as readonly string[]).includes(r.signalType) &&
        (r.direction === 'bullish' || r.direction === 'bearish'),
    );
    const directional = allDirectional.filter((r) => !isEtfRow(r));
    const etfRows = allDirectional.filter((r) => isEtfRow(r));
    const versionOk = directional.filter((r) => r.thresholdVersion === tVersion && r.regimeConfigVersion === rVersion);
    base.excludedByVersion = directional.length - versionOk.length;

    const retFieldName = `fwd${horizon}${basis === 'raw' ? 'Raw' : basis === 'exSpy' ? 'ExSpy' : 'ExSector'}`;
    const etfByType = new Map<string, { n: number; hits: number; sum: number }>();
    for (const r of etfRows) {
      const ret = (r as unknown as Record<string, number | null>)[retFieldName];
      if (ret === null || ret === undefined) continue;
      const s = etfByType.get(r.signalType) ?? { n: 0, hits: 0, sum: 0 };
      s.n += 1;
      if (r.direction === 'bullish' ? ret > 0 : ret < 0) s.hits += 1;
      s.sum += ret;
      etfByType.set(r.signalType, s);
    }
    const etfTrack = [...etfByType.entries()].map(([signalType, s]) => ({
      signalType,
      n: s.n,
      hits: s.hits,
      hitRate: s.hits / s.n,
      avgRet: s.sum / s.n,
    }));

    // ── Base-rate universe: one pass over persisted daily state ──
    const dms = await db.dailyMetric.findMany({
      where: { ...NOT_SEEDED },
      select: {
        symbol: true,
        date: true,
        close: true,
        putOI: true,
        callOI: true,
        spikeBaselineDays: true,
        final: true,
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
    const spyCloses = closes.get('SPY') ?? new Map<string, number>();
    const resolver = await loadBenchmarkResolver();

    const logRet = (m: Map<string, number> | undefined, from: string, to: string): number | null => {
      const a = m?.get(from);
      const b = m?.get(to);
      return a && b && a > 0 && b > 0 ? Math.log(b / a) : null;
    };
    const retOn = (symbol: string, d: string): number | null => {
      const i = sessionIdx.get(d);
      if (i === undefined || i + horizon > lastIdx) return null;
      const dh = sessions[i + horizon]!;
      const raw = logRet(closes.get(symbol), d, dh);
      if (raw === null || basis === 'raw') return raw;
      if (basis === 'exSpy') {
        const spy = logRet(spyCloses, d, dh);
        return spy === null ? null : raw - spy;
      }
      const benchSym = resolver.benchmarkFor(symbol);
      if (!benchSym || benchSym === symbol) return null;
      const sec = logRet(closes.get(benchSym), d, dh);
      return sec === null ? null : raw - sec;
    };

    // Eligibility date-sets per signal type per symbol (point-in-time persisted state).
    const eligible = new Map<string, Map<string, Set<string>>>(); // type → symbol → dates
    const addElig = (type: string, symbol: string, d: string): void => {
      const bySym = eligible.get(type) ?? new Map<string, Set<string>>();
      const set = bySym.get(symbol) ?? new Set<string>();
      set.add(d);
      bySym.set(symbol, set);
      eligible.set(type, bySym);
    };
    for (const r of dms) {
      if (!r.final || r.historicalCloseOnly) continue;
      const d = iso(r.date);
      if (r.putOI !== null && r.callOI !== null && r.callOI > 0) addElig('pc_extreme', r.symbol, d);
      if ((r.spikeBaselineDays ?? 0) >= 5) addElig('spike_alert', r.symbol, d);
    }
    for (const r of rels) {
      const d = iso(r.date);
      if (r.skewZ30 !== null) addElig('skew_z', r.symbol, d);
      if (r.divergenceWindow >= cfg.divergenceWindow) addElig('divergence', r.symbol, d);
    }

    // Regime-matched day counts per (type, symbol, cell), + cohort merges.
    // ETFs are excluded here too: the directional matrix (and its denominators)
    // is single names only.
    const counts = new Map<string, DayCounts>(); // `${type}|${sym}|${cell}`
    for (const [type, bySym] of eligible) {
      for (const [sym, dates] of bySym) {
        if (sectorOf(sym) === 'ETF') continue;
        for (const d of dates) {
          const cell = cellOf(d);
          if (cell === null) continue;
          const ret = retOn(sym, d);
          if (ret === null) continue;
          const k = `${type}|${sym}|${cell}`;
          const c = counts.get(k) ?? { pos: 0, neg: 0, total: 0 };
          if (ret > 0) c.pos += 1;
          else if (ret < 0) c.neg += 1;
          c.total += 1;
          counts.set(k, c);
        }
      }
    }
    // Cohort pools = per-member counts merged per (type, cohort, cell). The cell key
    // itself contains '|' separators, so parse only the first two tokens positionally.
    const cohortCounts = new Map<string, DayCounts[]>(); // `${type}|${cohort}|${cell}`
    for (const [k, c] of counts) {
      const firstSep = k.indexOf('|');
      const secondSep = k.indexOf('|', firstSep + 1);
      const type = k.slice(0, firstSep);
      const symbol = k.slice(firstSep + 1, secondSep);
      const cellKey = k.slice(secondSep + 1);
      const cohort = resolver.benchmarkFor(symbol);
      if (!cohort) continue;
      const ck = `${type}|${cohort}|${cellKey}`;
      const list = cohortCounts.get(ck) ?? [];
      list.push(c);
      cohortCounts.set(ck, list);
    }

    const matrixRows: MatrixRow[] = versionOk.map((r) => {
      const dir = r.direction as Direction;
      const cell = `${r.regimeVol ?? 'na'}|${r.regimeTrend ?? 'na'}|${r.regimeGamma ?? 'na'}`;
      const tickerC = counts.get(`${r.signalType}|${r.symbol}|${cell}`);
      let prob: number | null = null;
      let source: 'ticker' | 'cohort' | null = null;
      if (tickerC && tickerC.total >= cfg.baseRateMinTickerDays) {
        prob = baseHitProb(tickerC, dir);
        source = 'ticker';
      } else {
        const cohort = resolver.benchmarkFor(r.symbol);
        const pooled = cohort ? cohortCounts.get(`${r.signalType}|${cohort}|${cell}`) : undefined;
        if (pooled && pooled.length > 0) {
          const merged = mergeCounts(pooled);
          if (merged.total > 0) {
            prob = baseHitProb(merged, dir);
            source = 'cohort';
          }
        }
      }
      return {
        signalType: r.signalType,
        direction: dir,
        regimeVol: r.regimeVol,
        regimeTrend: r.regimeTrend,
        regimeGamma: r.regimeGamma,
        ret: (r as unknown as Record<string, number | null>)[retFieldName] ?? null,
        baseHitProb: prob,
        baseSource: source,
      };
    });

    // Event track: rich/cheap hits vs the unconditional undershoot base (all events incl. 'fair').
    const eventRows = scored.filter(
      (r) => r.signalType === 'event_badge' && r.realizedMove !== null && r.impliedMove !== null,
    );
    const predicted = eventRows
      .filter((r) => r.direction === 'rich' || r.direction === 'cheap')
      .map((r) => ({
        prediction: r.direction as 'rich' | 'cheap',
        impliedMove: r.impliedMove as number,
        realizedMove: r.realizedMove as number,
      }));
    const baseEvents = eventRows.map((r) => ({
      impliedMove: r.impliedMove as number,
      realizedMove: r.realizedMove as number,
    }));

    return {
      ...base,
      matrix: buildMatrix(matrixRows, cfg.minCellSample),
      eventTrack: eventRows.length > 0 ? eventTrackSummary(predicted, baseEvents) : null,
      backwardation,
      backwardationOpen,
      etfTrack,
    };
  });
}
