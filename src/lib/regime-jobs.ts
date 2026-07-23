/**
 * Daily regime jobs (Phase 4.1). DB-dependent; no-op without a database.
 *
 *  recordDailyRegime   — the live EOD path: classify today's triple (vol, trend,
 *      gamma) forward-only from the prior day's state, and freeze the row. Gamma
 *      is present here (live OI/IV). Never recomputes an existing final row.
 *  backfillRegimeHistory — a one-time seeding of vol + trend history from stored
 *      SPY closes and CBOE VIX/VIX3M history. Gamma is NULL for these dates — it
 *      cannot be reconstructed without historical OI/IV and is never fabricated.
 *
 * Classification is incremental and immutable (point-in-time integrity), and every
 * row is stamped with the regimeConfigVersion so a scoring window never spans two
 * deadband/persistence definitions.
 */
import { getAnalyticsConfig, type AnalyticsConfig } from './analytics-config';
import { CboeClient } from './cboe';
import { getDataProvider } from './data-source';
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import { INITIAL_HYSTERESIS, nextRegime, regimeConfigVersion, type HysteresisState, type RegimeCell } from './regime';
import { median } from './sector-stats';
import { NOT_SEEDED } from './seed-guard';
import { etDateKey } from './trading-calendar';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

function versionOf(cfg: AnalyticsConfig): string {
  return regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });
}

function asState(state: string | null, streak: number | null): HysteresisState {
  if (state === null) return INITIAL_HYSTERESIS;
  return { state: state as RegimeCell, streak: streak ?? 0 };
}

/** Classify today's regime triple and freeze it. Returns true if a row was written. */
export async function recordDailyRegime(engine: FlowEngine, now = new Date()): Promise<boolean> {
  const cfg = await getAnalyticsConfig();
  const version = versionOf(cfg);
  return (
    (await tryDb('record daily regime', async (db) => {
      const date = etDateKey(now);
      const existing = await db.dailyRegime.findUnique({ where: { date } });
      if (existing?.final) return false; // immutable — never recomputed

      // Vol input.
      const vixSpread = engine.marketContext?.vixSpread ?? null;

      // Trend input: SPY (SPX proxy) close + 50-day MA from stored closes.
      const spyRows = await db.dailyMetric.findMany({
        where: { symbol: 'SPY', close: { not: null }, date: { lte: date }, ...NOT_SEEDED },
        orderBy: { date: 'desc' },
        take: 50,
        select: { close: true },
      });
      const spyCloses = spyRows.map((r) => r.close as number);
      const spxClose = spyCloses[0] ?? engine.getFlow('SPY')?.underlyingPrice ?? null;
      const spx50ma = spyCloses.length >= 50 ? spyCloses.reduce((a, b) => a + b, 0) / spyCloses.length : null;

      // Gamma input: net summed GEX (classified) + breadth (share positive). Universe-scoped.
      let gexSum = 0;
      let gexPos = 0;
      let gexN = 0;
      for (const f of engine.allFlows()) {
        const g = f.analytics?.gexPer1Pct;
        if (typeof g === 'number' && Number.isFinite(g)) {
          gexSum += g;
          if (g > 0) gexPos += 1;
          gexN += 1;
        }
      }
      const aggGex = gexN > 0 ? gexSum : null;
      const gexBreadth = gexN > 0 ? gexPos / gexN : null;

      // Prior state (carry forward for incremental hysteresis).
      const prev = await db.dailyRegime.findFirst({ where: { date: { lt: date } }, orderBy: { date: 'desc' } });
      const prevVol = asState(prev?.volState ?? null, prev?.volStreak ?? null);
      const prevTrend = asState(prev?.trendState ?? null, prev?.trendStreak ?? null);
      const prevGamma = asState(prev?.gammaState ?? null, prev?.gammaStreak ?? null);

      // Gamma deadband scale = trailing median |aggGex|.
      const scaleRows = await db.dailyRegime.findMany({
        where: { aggGex: { not: null }, ...NOT_SEEDED },
        orderBy: { date: 'desc' },
        take: 60,
        select: { aggGex: true },
      });
      const scale = median(scaleRows.map((r) => Math.abs(r.aggGex as number))) ?? (aggGex !== null ? Math.abs(aggGex) : 0);

      // A missing dimension carries the prior state (streak cleared), never fabricated.
      const vol =
        vixSpread !== null
          ? nextRegime(prevVol, vixSpread, cfg.regimeVolDeadband, cfg.regimePersistDays)
          : { state: prevVol.state, streak: 0 };
      const trend =
        spxClose !== null && spx50ma !== null
          ? nextRegime(prevTrend, spxClose - spx50ma, cfg.regimeTrendDeadbandPct * spx50ma, cfg.regimePersistDays)
          : { state: prevTrend.state, streak: 0 };
      const gamma =
        aggGex !== null
          ? nextRegime(prevGamma, aggGex, Math.max(scale * cfg.regimeGammaDeadbandFrac, 0), cfg.regimePersistDays)
          : null;

      const data = {
        volState: vol.state,
        trendState: trend.state,
        gammaState: gamma?.state ?? null,
        volStreak: vol.streak,
        trendStreak: trend.streak,
        gammaStreak: gamma?.streak ?? null,
        vixSpread,
        spxClose,
        spx50ma,
        aggGex,
        gexBreadth,
        regimeConfigVersion: version,
        final: true,
      };
      await db.dailyRegime.upsert({ where: { date }, create: { date, ...data }, update: data });
      return true;
    })) ?? false
  );
}

/**
 * One-time seeding of vol + trend regime history (gamma NULL) from stored SPY
 * closes and CBOE VIX/VIX3M history. Runs only when DailyRegime is empty, so it
 * never overwrites a finalized row and the forward hysteresis stays continuous.
 */
export async function backfillRegimeHistory(now = new Date()): Promise<number> {
  const cfg = await getAnalyticsConfig();
  const version = versionOf(cfg);
  const provider = getDataProvider();
  return (
    (await tryDb('backfill regime history', async (db) => {
      if ((await db.dailyRegime.count()) > 0) return 0; // already seeded

      const spyRows = await db.dailyMetric.findMany({
        where: { symbol: 'SPY', close: { not: null }, ...NOT_SEEDED },
        orderBy: { date: 'asc' },
        select: { date: true, close: true },
      });
      if (spyRows.length < 50) return 0;

      // VIX term-structure history (optional — vol stays null if unavailable).
      const vixSpread = new Map<string, number>();
      if (provider instanceof CboeClient) {
        try {
          const [vix, vix3m] = await Promise.all([
            provider.getDailyClosesDated('_VIX', 800),
            provider.getDailyClosesDated('_VIX3M', 800),
          ]);
          const v3 = new Map(vix3m.map((d) => [iso(d.date), d.close]));
          for (const d of vix) {
            const far = v3.get(iso(d.date));
            if (far !== undefined) vixSpread.set(iso(d.date), far - d.close);
          }
        } catch {
          /* leave vol null */
        }
      }

      const today = etDateKey(now).getTime();
      const closes = spyRows.map((r) => r.close as number);
      let vol = INITIAL_HYSTERESIS;
      let trend = INITIAL_HYSTERESIS;
      const rows: {
        date: Date;
        volState: string;
        trendState: string;
        gammaState: null;
        volStreak: number;
        trendStreak: number;
        gammaStreak: null;
        vixSpread: number | null;
        spxClose: number;
        spx50ma: number;
        aggGex: null;
        gexBreadth: null;
        regimeConfigVersion: string;
        final: boolean;
      }[] = [];
      for (let i = 0; i < spyRows.length; i++) {
        const d = spyRows[i]!.date;
        if (d.getTime() >= today) break; // historical only; live path owns today onward
        const spxClose = closes[i]!;
        const spx50ma = i + 1 >= 50 ? closes.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50 : null;
        const vs = vixSpread.get(iso(d)) ?? null;
        vol = vs !== null ? nextRegime(vol, vs, cfg.regimeVolDeadband, cfg.regimePersistDays) : { state: vol.state, streak: 0 };
        if (spx50ma === null) continue; // trend warm-up; don't store a partial row
        trend = nextRegime(trend, spxClose - spx50ma, cfg.regimeTrendDeadbandPct * spx50ma, cfg.regimePersistDays);
        rows.push({
          date: d,
          volState: vol.state,
          trendState: trend.state,
          gammaState: null,
          volStreak: vol.streak,
          trendStreak: trend.streak,
          gammaStreak: null,
          vixSpread: vs,
          spxClose,
          spx50ma,
          aggGex: null,
          gexBreadth: null,
          regimeConfigVersion: version,
          final: true,
        });
      }
      if (rows.length > 0) await db.dailyRegime.createMany({ data: rows, skipDuplicates: true });
      return rows.length;
    })) ?? 0
  );
}
