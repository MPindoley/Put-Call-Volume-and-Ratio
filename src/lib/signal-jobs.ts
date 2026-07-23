/**
 * Phase 4.2/4.3 jobs: signal emission, backwardation episodes, forward scoring.
 * DB-dependent; no-op without a database.
 *
 *  logSignals    — at EOD, AFTER finalize + recordDailyRegime: emit one immutable
 *      SignalLog row per active signal from that session's FINALIZED, non-seeded
 *      rows only (never provisional), stamped with the regime triple and every
 *      version (composition, weight method, regime config, thresholds). Idempotent
 *      via the (symbol, type, date) unique key; a past signal is never recomputed
 *      under later baselines.
 *  trackBackwardationEpisodes — open/extend/close episodes forward-only from the
 *      persisted daily termSlope; on close, classify the resolution and join it
 *      back to the episode's logged signal.
 *  scoreSignals  — once 20 trading days have elapsed, fill forward log returns
 *      (raw, excess-vs-SPY, excess-vs-sector) from stored closes, and the realized
 *      move for event-badge rows from the confirmed EarningsEvent.
 */
import type { PrismaClient } from '@prisma/client';
import { getAnalyticsConfig } from './analytics-config';
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import { defaultInstrument, interpretDivergence, loadInstrumentConfigs } from './interpretation';
import { loadBenchmarkResolver } from './sector-benchmarks';
import { NOT_SEEDED } from './seed-guard';
import { BACKWARDATION_SLOPE, classifyCurveResolution, classifyResolution, thresholdVersion } from './signals';
import { regimeConfigVersion } from './regime';
import { etDateKey } from './trading-calendar';
import { sectorOf } from './universe';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utcDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

type Dir = 'bullish' | 'bearish';
const flip = (d: Dir, inverse: boolean): Dir => (inverse ? (d === 'bullish' ? 'bearish' : 'bullish') : d);

/** Emit today's signals from finalized rows. Returns rows written. */
export async function logSignals(engine: FlowEngine, now = new Date()): Promise<number> {
  const cfg = await getAnalyticsConfig();
  const tVersion = thresholdVersion(cfg);
  const rVersion = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });
  return (
    (await tryDb('log signals', async (db) => {
      const date = etDateKey(now);
      const regime = await db.dailyRegime.findUnique({ where: { date } });
      if (!regime?.final) return 0; // signals only fire against a finalized regime row

      const dms = await db.dailyMetric.findMany({
        where: { date, final: true, historicalCloseOnly: false, ...NOT_SEEDED },
      });
      const rels = await db.relativeMetric.findMany({ where: { date, final: true, ...NOT_SEEDED } });
      const relBySym = new Map(rels.map((r) => [r.symbol, r]));
      const cohortRows = await db.cohortDaily.findMany({ where: { date }, select: { cohort: true, dispersionWeightMethod: true } });
      const weightByCohort = new Map(cohortRows.map((c) => [c.cohort, c.dispersionWeightMethod]));
      const instruments = await loadInstrumentConfigs();

      // Per-ticker gamma regime where available, else the aggregate.
      const stamps = {
        regimeVol: regime.volState,
        regimeTrend: regime.trendState,
        regimeGamma: regime.gammaState,
        regimeConfigVersion: rVersion,
        thresholdVersion: tVersion,
      };

      interface Row {
        symbol: string;
        signalType: string;
        direction: string | null;
        isEtf: boolean;
        magnitude: number | null;
        detail: string | null;
        impliedMove?: number | null;
        eventDate?: Date | null;
        compositionVersion: string;
        weightMethod: string | null;
      }
      const rows: Row[] = [];
      // ETF/index flow is structurally hedging — tagged here, routed out of the
      // directional matrix (into its own reference panel) by the matrix builder.
      const isEtf = (symbol: string): boolean => sectorOf(symbol) === 'ETF';
      const stampFor = (symbol: string): { isEtf: boolean; compositionVersion: string; weightMethod: string | null } => {
        const rel = relBySym.get(symbol);
        return {
          isEtf: isEtf(symbol),
          compositionVersion: rel?.compositionVersion ?? '',
          weightMethod: rel?.cohort ? (weightByCohort.get(rel.cohort) ?? null) : null,
        };
      };

      for (const dm of dms) {
        const inverse = (instruments.get(dm.symbol) ?? defaultInstrument(dm.symbol)).inverse;
        const rel = relBySym.get(dm.symbol);

        // divergence — direction in underlying-exposure terms (inverse-adjusted).
        const divType = interpretDivergence(
          rel?.divergenceType === 'distribution' || rel?.divergenceType === 'accumulation' ? rel.divergenceType : null,
          inverse,
        );
        if (divType) {
          rows.push({
            symbol: dm.symbol,
            signalType: 'divergence',
            direction: divType === 'distribution' ? 'bearish' : 'bullish',
            magnitude: rel?.skewTrendTNW ?? rel?.skewTrendT ?? null,
            detail: divType,
            ...stampFor(dm.symbol),
          });
        }

        // skew_z — relative-skew z extreme.
        if (rel?.skewZ30 !== null && rel?.skewZ30 !== undefined && Math.abs(rel.skewZ30) >= cfg.skewZExtreme) {
          rows.push({
            symbol: dm.symbol,
            signalType: 'skew_z',
            direction: flip(rel.skewZ30 > 0 ? 'bullish' : 'bearish', inverse),
            magnitude: rel.skewZ30,
            detail: null,
            ...stampFor(dm.symbol),
          });
        }

        // pc_extreme — OI-based put/call ratio beyond the bands.
        if (dm.putOI !== null && dm.callOI !== null && dm.callOI > 0) {
          const pc = dm.putOI / dm.callOI;
          if (pc >= cfg.pcHigh || pc <= cfg.pcLow) {
            rows.push({
              symbol: dm.symbol,
              signalType: 'pc_extreme',
              direction: flip(pc >= cfg.pcHigh ? 'bearish' : 'bullish', inverse),
              magnitude: Number(pc.toFixed(3)),
              detail: null,
              ...stampFor(dm.symbol),
            });
          }
        }

        // regime_detach — magnitude track (no direction).
        if (rel?.regimeDetach) {
          rows.push({
            symbol: dm.symbol,
            signalType: 'regime_detach',
            direction: null,
            magnitude: null,
            detail: `${rel.regimeDetachMetric ?? '?'}:${rel.regimeDetachDir ?? '?'}`,
            ...stampFor(dm.symbol),
          });
        }

        // event_badge — rich/cheap prediction track (own hit definition). Mid-percentile
        // events are logged as 'fair': no hit is scored on them, but their implied-vs-
        // realized pair feeds the unconditional undershoot base rate.
        const gauge = engine.getFlow(dm.symbol)?.eventGauge;
        if (gauge?.display && gauge.percentile !== null && gauge.impliedMove !== null && gauge.eventDate) {
          const pred = gauge.percentile >= 70 ? 'rich' : gauge.percentile <= 30 ? 'cheap' : 'fair';
          rows.push({
            symbol: dm.symbol,
            signalType: 'event_badge',
            direction: pred,
            magnitude: gauge.percentile,
            detail: null,
            impliedMove: gauge.impliedMove,
            eventDate: utcDate(gauge.eventDate),
            ...stampFor(dm.symbol),
          });
        }
      }

      // spike_alert — from today's persisted alerts (strongest per symbol).
      const since = new Date(date.getTime() - DAY_MS);
      const alerts = await db.alert.findMany({ where: { createdAt: { gte: since } } });
      const best = new Map<string, (typeof alerts)[number]>();
      for (const a of alerts) {
        if (etDateKey(a.createdAt).getTime() !== date.getTime()) continue;
        const prev = best.get(a.symbol);
        if (!prev || a.volumeMultiple > prev.volumeMultiple) best.set(a.symbol, a);
      }
      for (const a of best.values()) {
        const inverse = (instruments.get(a.symbol) ?? defaultInstrument(a.symbol)).inverse;
        rows.push({
          symbol: a.symbol,
          signalType: 'spike_alert',
          direction: flip(a.putCallRatio > 1 ? 'bearish' : 'bullish', inverse),
          magnitude: a.volumeMultiple,
          detail: a.level,
          ...stampFor(a.symbol),
        });
      }

      if (rows.length === 0) return 0;
      const res = await db.signalLog.createMany({
        data: rows.map((r) => ({ firedOn: date, ...stamps, ...r })),
        skipDuplicates: true, // idempotent re-runs never rewrite an emitted signal
      });
      return res.count;
    })) ?? 0
  );
}

const DAY_MS = 86_400_000;

/** Open/extend/close backwardation episodes from today's persisted termSlope. */
export async function trackBackwardationEpisodes(now = new Date()): Promise<void> {
  const cfg = await getAnalyticsConfig();
  const tVersion = thresholdVersion(cfg);
  await tryDb('track backwardation episodes', async (db) => {
    const date = etDateKey(now);
    const regime = await db.dailyRegime.findUnique({ where: { date } });
    if (!regime?.final) return;
    const dms = await db.dailyMetric.findMany({
      where: { date, final: true, historicalCloseOnly: false, termSlope: { not: null }, ...NOT_SEEDED },
      select: { symbol: true, termSlope: true, atmIvNear: true, atmIvFar: true, iv30: true, close: true },
    });
    for (const dm of dms) {
      const slope = dm.termSlope as number;
      const open = await db.backwardationEpisode.findFirst({ where: { symbol: dm.symbol, endDate: null, ...NOT_SEEDED } });
      if (slope < BACKWARDATION_SLOPE) {
        if (!open) {
          const ep = await db.backwardationEpisode.create({
            data: {
              symbol: dm.symbol,
              startDate: date,
              entrySlope: slope,
              minSlope: slope,
              entryIv30: dm.iv30,
              entryIvNear: dm.atmIvNear,
              entryIvFar: dm.atmIvFar,
            },
          });
          await db.signalLog.upsert({
            where: { symbol_signalType_firedOn: { symbol: dm.symbol, signalType: 'backwardation', firedOn: date } },
            create: {
              symbol: dm.symbol,
              signalType: 'backwardation',
              firedOn: date,
              direction: null,
              isEtf: sectorOf(dm.symbol) === 'ETF',
              magnitude: slope,
              detail: 'open',
              episodeId: ep.id,
              regimeVol: regime.volState,
              regimeTrend: regime.trendState,
              regimeGamma: regime.gammaState,
              regimeConfigVersion: regime.regimeConfigVersion,
              thresholdVersion: tVersion,
            },
            update: {},
          });
        } else if (slope < open.minSlope) {
          await db.backwardationEpisode.update({ where: { id: open.id }, data: { minSlope: slope } });
        }
      } else if (open) {
        // Close: cumulative log return from the episode-start close to today's.
        const startDm = await db.dailyMetric.findUnique({
          where: { symbol_date: { symbol: dm.symbol, date: open.startDate } },
          select: { close: true },
        });
        const cumReturn =
          startDm?.close && dm.close && startDm.close > 0 && dm.close > 0 ? Math.log(dm.close / startDm.close) : null;
        // PRIMARY resolution: curve shape from persisted components. Episodes opened
        // before components were stored fall back to the iv30 + slope proxy
        // (near ≈ iv30, far ≈ iv30 + slope) rather than dropping to 'unknown'.
        // resolutionMethod stamps which path was taken so proxy- and component-
        // classified episodes never silently mix in resolution statistics.
        const hasComponents =
          open.entryIvNear !== null && open.entryIvFar !== null && dm.atmIvNear !== null && dm.atmIvFar !== null;
        const entryNear = open.entryIvNear ?? open.entryIv30;
        const entryFar = open.entryIvFar ?? (open.entryIv30 !== null ? open.entryIv30 + open.entrySlope : null);
        const exitNear = dm.atmIvNear ?? dm.iv30;
        const exitFar = dm.atmIvFar ?? (dm.iv30 !== null ? dm.iv30 + slope : null);
        const resolution = classifyCurveResolution(entryNear, entryFar, exitNear, exitFar);
        const outcome = classifyResolution(cumReturn, open.entryIv30, dm.iv30);
        await db.backwardationEpisode.update({
          where: { id: open.id },
          data: {
            endDate: date,
            exitSlope: slope,
            exitIv30: dm.iv30,
            exitIvNear: dm.atmIvNear,
            exitIvFar: dm.atmIvFar,
            cumReturn,
            resolution,
            resolutionMethod: hasComponents ? 'components' : 'proxy',
            outcome,
          },
        });
        await db.signalLog.updateMany({ where: { episodeId: open.id }, data: { detail: `${resolution}/${outcome}` } });
      }
    }
  });
}

/**
 * Fill forward returns for signals whose 20-trading-day window has elapsed.
 * Sessions are the canonical SPY close dates; a missing ticker/benchmark close at
 * an offset leaves that field null. Returns rows scored.
 */
export async function scoreSignals(now = new Date()): Promise<number> {
  return (
    (await tryDb('score signals', async (db) => {
      const spyRows = await db.dailyMetric.findMany({
        where: { symbol: 'SPY', close: { not: null }, ...NOT_SEEDED },
        orderBy: { date: 'asc' },
        select: { date: true, close: true },
      });
      const sessions = spyRows.map((r) => iso(r.date));
      const sessionIdx = new Map(sessions.map((d, i) => [d, i]));
      const spyClose = new Map(spyRows.map((r) => [iso(r.date), r.close as number]));
      const lastIdx = sessions.length - 1;

      const pending = await db.signalLog.findMany({ where: { scored: false }, orderBy: { firedOn: 'asc' }, take: 2000 });
      if (pending.length === 0) return 0;
      const resolver = await loadBenchmarkResolver();

      const closesCache = new Map<string, Map<string, number>>();
      const closesOf = async (symbol: string): Promise<Map<string, number>> => {
        const hit = closesCache.get(symbol);
        if (hit) return hit;
        const rows = await db.dailyMetric.findMany({
          where: { symbol, close: { not: null }, ...NOT_SEEDED },
          select: { date: true, close: true },
        });
        const map = new Map(rows.map((r) => [iso(r.date), r.close as number]));
        closesCache.set(symbol, map);
        return map;
      };
      const logRet = (closes: Map<string, number>, from: string, to: string): number | null => {
        const a = closes.get(from);
        const b = closes.get(to);
        return a && b && a > 0 && b > 0 ? Math.log(b / a) : null;
      };

      let scored = 0;
      for (const sig of pending) {
        const d0 = iso(sig.firedOn);
        const i0 = sessionIdx.get(d0);
        if (i0 === undefined || i0 + 20 > lastIdx) continue; // window not elapsed yet

        const tCloses = await closesOf(sig.symbol);
        const benchSym = resolver.benchmarkFor(sig.symbol);
        const bCloses = benchSym && benchSym !== sig.symbol ? await closesOf(benchSym) : null;

        const data: Record<string, number | boolean | null> = { scored: true };
        for (const h of [5, 10, 20] as const) {
          const dh = sessions[i0 + h]!;
          const raw = logRet(tCloses, d0, dh);
          const spy = logRet(spyClose, d0, dh);
          const sec = bCloses ? logRet(bCloses, d0, dh) : null;
          data[`fwd${h}Raw`] = raw;
          data[`fwd${h}ExSpy`] = raw !== null && spy !== null ? raw - spy : null;
          data[`fwd${h}ExSector`] = raw !== null && sec !== null ? raw - sec : null;
        }

        // Event-badge realized move from the confirmed calendar event.
        if (sig.signalType === 'event_badge' && sig.eventDate) {
          const ev = await db.earningsEvent.findUnique({
            where: { symbol_date: { symbol: sig.symbol, date: sig.eventDate } },
          });
          if (ev?.realizedMovePct !== null && ev?.realizedMovePct !== undefined && !ev.realizedTimingUncertain) {
            data.realizedMove = ev.realizedMovePct;
          } else {
            const evIdx = sessionIdx.get(iso(sig.eventDate));
            const stale = evIdx !== undefined && evIdx + 25 <= lastIdx;
            if (!stale) continue; // wait for the realized move before scoring
            // Unconfirmed/unmeasurable event → scored with realized null (excluded from the track).
          }
        }

        await db.signalLog.update({ where: { id: sig.id }, data });
        scored += 1;
      }
      return scored;
    })) ?? 0
  );
}
