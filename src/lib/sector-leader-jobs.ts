/**
 * Loads a cohort's stored history for the who-leads-whom ranking
 * (sector-leaders.ts). Computed on demand for the Cohorts page and cached
 * until the next session is finalized.
 */
import { tryDb } from './db';
import { finalizedMetricWhere } from './finalized-reads';
import { listCohorts, loadBenchmarkResolver } from './sector-benchmarks';
import { LEADER_PARAMS, sectorLeaders, type LeaderInput, type LeadersResult } from './sector-leaders';

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 400;

export interface LeadersReport extends LeadersResult {
  cohort: string;
  label: string;
  /** Latest finalized session the ranking runs through. */
  asOf: string | null;
  members: number;
  params: { minObs: number; tCut: number };
  /** Every cohort, for the picker. */
  cohorts: { cohort: string; label: string }[];
}

const cache = globalThis as unknown as { __leadersCache?: Map<string, { key: string; report: LeadersReport }> };

/** A cohort's ranking; the first cohort when none (or an unknown one) is asked for. Null without a database. */
export async function loadSectorLeaders(cohortIn?: string | null): Promise<LeadersReport | null> {
  const store = (cache.__leadersCache ??= new Map());
  return tryDb('sector leaders', async (db) => {
    const cohorts = [...listCohorts(await loadBenchmarkResolver())].sort(([, a], [, b]) => a.label.localeCompare(b.label));
    const picked = cohorts.find(([c]) => c === cohortIn) ?? cohorts[0];
    if (!picked) return null;
    const [cohort, { label, members }] = picked;
    const latest = await db.dailyMetric.findFirst({
      where: finalizedMetricWhere({ symbol: 'SPY', close: { not: null } }),
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    const key = latest?.date.toISOString() ?? 'none';
    const hit = store.get(cohort);
    if (hit && hit.key === key) return hit.report;

    const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS);
    const [closes, skews] = await Promise.all([
      db.dailyMetric.findMany({
        where: finalizedMetricWhere({ symbol: { in: [cohort, 'SPY'] }, close: { not: null }, date: { gte: since } }),
        select: { symbol: true, date: true, close: true },
      }),
      db.dailyMetric.findMany({
        where: finalizedMetricWhere({
          symbol: { in: members },
          rrSkew: { not: null },
          historicalCloseOnly: false,
          date: { gte: since },
        }),
        select: { symbol: true, date: true, rrSkew: true },
      }),
    ]);
    // The session clock: every date SPY has a close.
    const dates = [...new Set(closes.filter((c) => c.symbol === 'SPY').map((c) => c.date.getTime()))].sort((a, b) => a - b);
    const sessionOf = new Map(dates.map((t, i) => [t, i]));
    const series = (symbol: string): Map<number, number> => {
      const m = new Map<number, number>();
      for (const c of closes) {
        const s = sessionOf.get(c.date.getTime());
        if (c.symbol === symbol && s !== undefined && c.close !== null) m.set(s, c.close);
      }
      return m;
    };
    const bySymbol = new Map<string, Map<number, number>>();
    for (const r of skews) {
      const s = sessionOf.get(r.date.getTime());
      if (s === undefined || r.rrSkew === null) continue;
      const m = bySymbol.get(r.symbol) ?? new Map<number, number>();
      m.set(s, r.rrSkew);
      bySymbol.set(r.symbol, m);
    }
    const names: LeaderInput[] = [...bySymbol].map(([symbol, skew]) => ({ symbol, skew }));
    const report: LeadersReport = {
      cohort,
      label,
      asOf: latest ? latest.date.toISOString().slice(0, 10) : null,
      members: members.length,
      params: { minObs: LEADER_PARAMS.minObs, tCut: LEADER_PARAMS.tCut },
      cohorts: cohorts.map(([c, v]) => ({ cohort: c, label: v.label })),
      ...sectorLeaders(names, series(cohort), series('SPY')),
    };
    store.set(cohort, { key, report });
    return report;
  });
}
