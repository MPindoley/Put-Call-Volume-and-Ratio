/**
 * Loads a stock's (and its sector peers') finalized history for the
 * relationships analysis (relationships.ts). Computed on demand for the
 * ticker page and cached until the next session is finalized.
 */
import { tryDb } from './db';
import {
  buildFeatureRows,
  coMovement,
  findAnalogs,
  leadTable,
  type AnalogResult,
  type CoMovement,
  type DayInput,
  type FeatureRow,
  type LeadRow,
} from './relationships';
import { sectorOf, TRACKED_UNIVERSE } from './universe';

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 550;
/** Sector peers compared (the curated core comes first in universe order). */
const MAX_PEERS = 150;
const CACHE_MAX = 200;

export interface RelationshipsReport {
  symbol: string;
  sector: string;
  /** The finalized session the analysis runs through (YYYY-MM-DD). */
  asOf: string | null;
  /** This stock's sessions with at least one measurement. */
  tickerSessions: number;
  sectorNames: number;
  sectorSessions: number;
  leads: LeadRow[];
  coMovement: CoMovement;
  analogs: AnalogResult;
}

const cache = globalThis as unknown as { __relationshipsCache?: Map<string, { key: string; report: RelationshipsReport }> };

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export async function loadRelationships(symbol: string): Promise<RelationshipsReport | null> {
  const store = (cache.__relationshipsCache ??= new Map());
  return tryDb('relationships', async (db) => {
    const latest = await db.dailyMetric.findFirst({
      where: { symbol, final: true, seeded: false, close: { not: null } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    const key = latest ? iso(latest.date) : 'none';
    const hit = store.get(symbol);
    if (hit && hit.key === key) return hit.report;

    const sector = sectorOf(symbol);
    const peers = [symbol, ...TRACKED_UNIVERSE.map((u) => u.symbol).filter((s) => s !== symbol && sectorOf(s) === sector)].slice(
      0,
      MAX_PEERS,
    );
    // Only the span with options measurements matters (plus a month for returns/IV rank warm-up).
    const firstIv = await db.dailyMetric.findFirst({
      where: { final: true, seeded: false, iv30: { not: null }, date: { gte: new Date(Date.now() - LOOKBACK_DAYS * DAY_MS) } },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const since = firstIv ? new Date(firstIv.date.getTime() - 45 * DAY_MS) : new Date(Date.now() - LOOKBACK_DAYS * DAY_MS);

    const [metrics, relative, regimes] = await Promise.all([
      db.dailyMetric.findMany({
        where: { symbol: { in: [...peers, 'SPY'] }, final: true, seeded: false, close: { not: null }, date: { gte: since } },
        select: { symbol: true, date: true, close: true, iv30: true, termSlope: true, optVolume: true },
      }),
      db.relativeMetric.findMany({
        where: { symbol: { in: peers }, final: true, seeded: false, date: { gte: since } },
        select: { symbol: true, date: true, skewZ30: true, ivZ30: true, oiPcZ30: true, ivHvZ30: true },
      }),
      db.dailyRegime.findMany({ where: { final: true, seeded: false, date: { gte: since } }, select: { date: true, volState: true, trendState: true } }),
    ]);

    const dates = [...new Set(metrics.map((m) => m.date.getTime()))].sort((a, b) => a - b);
    const sessionOf = new Map(dates.map((t, i) => [t, i]));
    const spy = new Map<number, number>();
    for (const m of metrics) if (m.symbol === 'SPY' && m.close !== null) spy.set(sessionOf.get(m.date.getTime())!, m.close);
    const regimeBySession = new Map<number, string>();
    for (const r of regimes) {
      const s = sessionOf.get(r.date.getTime());
      if (s !== undefined) regimeBySession.set(s, `${r.volState}|${r.trendState}`);
    }
    const rel = new Map(relative.map((r) => [`${r.symbol}|${r.date.getTime()}`, r]));
    const daysBySymbol = new Map<string, DayInput[]>();
    for (const m of metrics) {
      if (m.symbol === 'SPY' && symbol !== 'SPY') continue;
      const r = rel.get(`${m.symbol}|${m.date.getTime()}`);
      const list = daysBySymbol.get(m.symbol) ?? [];
      list.push({
        session: sessionOf.get(m.date.getTime())!,
        date: iso(m.date),
        close: m.close as number,
        iv30: m.iv30,
        termSlope: m.termSlope,
        optVolume: m.optVolume,
        skewZ30: r?.skewZ30 ?? null,
        ivZ30: r?.ivZ30 ?? null,
        oiPcZ30: r?.oiPcZ30 ?? null,
        ivHvZ30: r?.ivHvZ30 ?? null,
      });
      daysBySymbol.set(m.symbol, list);
    }

    const hasFeatures = (r: FeatureRow): boolean => Object.keys(r.features).length > 0;
    const sectorRows: FeatureRow[] = [];
    let tickerRows: FeatureRow[] = [];
    for (const [s, days] of daysBySymbol) {
      const rows = buildFeatureRows(s, days, spy, regimeBySession).filter(hasFeatures);
      sectorRows.push(...rows);
      if (s === symbol) tickerRows = rows;
    }
    const today = tickerRows.length > 0 ? tickerRows[tickerRows.length - 1]! : null;

    const report: RelationshipsReport = {
      symbol,
      sector,
      asOf: latest ? iso(latest.date) : null,
      tickerSessions: tickerRows.length,
      sectorNames: daysBySymbol.size,
      sectorSessions: sectorRows.length,
      leads: leadTable(tickerRows, sectorRows),
      coMovement: coMovement(tickerRows),
      analogs: findAnalogs(today, sectorRows),
    };
    if (store.size >= CACHE_MAX) store.delete(store.keys().next().value as string);
    store.set(symbol, { key, report });
    return report;
  });
}
