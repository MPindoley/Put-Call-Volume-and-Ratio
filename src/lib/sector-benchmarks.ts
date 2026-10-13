/**
 * Sector → benchmark ETF mapping. Each GICS sector maps to its SPDR sector
 * fund; per-ticker industry overrides (e.g. NVDA → SMH, MRNA → XBI) let a name
 * be measured against a tighter industry benchmark. Defaults live here; the DB
 * (SectorBenchmark table + TickerOverride.benchmarkEtf) overrides them so you
 * can edit without a code change.
 *
 * The benchmark ETF is always EXCLUDED from its own sector's constituent set,
 * so sector medians and the ticker-vs-median spread are pure single-name reads.
 */
import type { Sector } from '@/types';
import { tryDb } from './db';
import { sectorOf, TRACKED_UNIVERSE } from './universe';

export const DEFAULT_SECTOR_BENCHMARKS: Record<Sector, string | null> = {
  Technology: 'XLK',
  Financials: 'XLF',
  Healthcare: 'XLV',
  Energy: 'XLE',
  Industrials: 'XLI',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  Utilities: 'XLU',
  Materials: 'XLB',
  'Real Estate': 'XLRE',
  'Communication Services': 'XLC',
  ETF: null,
  Unknown: null,
};

/**
 * Human labels for industry-ETF cohorts (names overridden away from their GICS
 * SPDR). Sector-SPDR cohorts get labeled "<Sector> (<ETF>)" automatically.
 */
export const INDUSTRY_COHORT_LABELS: Record<string, string> = {
  SMH: 'Semiconductors (SMH)',
  XBI: 'Biotech (XBI)',
};

/** Optional industry-benchmark overrides for names whose sector ETF is a poor proxy. */
export const DEFAULT_TICKER_BENCHMARKS: Record<string, string> = {
  NVDA: 'SMH',
  AMD: 'SMH',
  AVGO: 'SMH',
  MU: 'SMH',
  LRCX: 'SMH',
  AMAT: 'SMH',
  KLAC: 'SMH',
  TSM: 'SMH',
  ASML: 'SMH',
  MRVL: 'SMH',
  ON: 'SMH',
  NXPI: 'SMH',
  MRNA: 'XBI',
  BIIB: 'XBI',
  VRTX: 'XBI',
  REGN: 'XBI',
  GILD: 'XBI',
  SRPT: 'XBI',
  EXAS: 'XBI',
};

/** The set of ETFs that serve as benchmarks (excluded from constituent medians). */
export function benchmarkEtfSet(
  sectorBenchmarks: Record<string, string | null> = DEFAULT_SECTOR_BENCHMARKS,
  tickerBenchmarks: Record<string, string> = DEFAULT_TICKER_BENCHMARKS,
): Set<string> {
  const set = new Set<string>();
  for (const etf of Object.values(sectorBenchmarks)) if (etf) set.add(etf);
  for (const etf of Object.values(tickerBenchmarks)) set.add(etf);
  return set;
}

export interface BenchmarkResolver {
  sectorBenchmarks: Record<string, string | null>;
  tickerBenchmarks: Record<string, string>;
  /** The benchmark ETF for a name = its COHORT key (override → sector default). */
  benchmarkFor(symbol: string): string | null;
  /** Sector for a name, surviving its removal from the live universe. */
  sectorFor(symbol: string): string;
  isBenchmark(symbol: string): boolean;
}

/**
 * Sector for a symbol, surviving universe edits. The live universe map is the
 * current classification, but a name REMOVED from the universe (delisted,
 * acquired) reads as 'Unknown' there. Historical work on that name — grading
 * its still-pending signals, pooling its record into sector statistics — would
 * then silently lose its sector benchmark and be misfiled. Fall back to the
 * sector persisted on its Ticker row from when it was tracked.
 */
export function sectorWithFallback(symbol: string, persisted: ReadonlyMap<string, string>): string {
  const live = sectorOf(symbol);
  return live !== 'Unknown' ? live : (persisted.get(symbol) ?? 'Unknown');
}

/** Human label for a cohort key (benchmark ETF). */
export function cohortLabel(
  cohortKey: string,
  sectorBenchmarks: Record<string, string | null> = DEFAULT_SECTOR_BENCHMARKS,
): string {
  if (INDUSTRY_COHORT_LABELS[cohortKey]) return INDUSTRY_COHORT_LABELS[cohortKey] as string;
  const sector = (Object.entries(sectorBenchmarks).find(([, etf]) => etf === cohortKey)?.[0]) as Sector | undefined;
  return sector ? `${sector} (${cohortKey})` : cohortKey;
}

/**
 * Enumerate cohorts: each distinct benchmark ETF that at least one tracked
 * single name resolves to, with its label and DEFINED member set (mutually
 * exclusive — one name, one cohort). This defines median membership; the daily
 * liquidity/IQR filter narrows it further per day.
 */
export function listCohorts(resolver: BenchmarkResolver): Map<string, { label: string; members: string[] }> {
  const byCohort = new Map<string, string[]>();
  for (const { symbol, sector } of TRACKED_UNIVERSE) {
    if (sector === 'ETF' || sector === 'Unknown' || resolver.isBenchmark(symbol)) continue;
    const cohort = resolver.benchmarkFor(symbol);
    if (!cohort) continue;
    const list = byCohort.get(cohort) ?? [];
    list.push(symbol);
    byCohort.set(cohort, list);
  }
  const out = new Map<string, { label: string; members: string[] }>();
  for (const [cohort, members] of byCohort) {
    out.set(cohort, { label: cohortLabel(cohort, resolver.sectorBenchmarks), members: members.sort() });
  }
  return out;
}

/** Build a resolver, layering DB overrides over the code defaults. */
export async function loadBenchmarkResolver(): Promise<BenchmarkResolver> {
  const sectorBenchmarks: Record<string, string | null> = { ...DEFAULT_SECTOR_BENCHMARKS };
  const tickerBenchmarks: Record<string, string> = { ...DEFAULT_TICKER_BENCHMARKS };
  const persistedSectors = new Map<string, string>();

  await tryDb('load sector benchmarks', async (db) => {
    for (const row of await db.sectorBenchmark.findMany()) {
      sectorBenchmarks[row.sector] = row.benchmarkEtf;
    }
    const overrides = await db.tickerOverride.findMany({ where: { benchmarkEtf: { not: null } } });
    for (const o of overrides) if (o.benchmarkEtf) tickerBenchmarks[o.symbol] = o.benchmarkEtf;
    for (const t of await db.ticker.findMany({ select: { symbol: true, sector: true } })) {
      persistedSectors.set(t.symbol, t.sector);
    }
  });

  const benchmarks = benchmarkEtfSet(sectorBenchmarks, tickerBenchmarks);
  const sectorFor = (symbol: string): string => sectorWithFallback(symbol, persistedSectors);

  return {
    sectorBenchmarks,
    tickerBenchmarks,
    benchmarkFor(symbol: string): string | null {
      return tickerBenchmarks[symbol] ?? sectorBenchmarks[sectorFor(symbol)] ?? null;
    },
    sectorFor,
    isBenchmark(symbol: string): boolean {
      return benchmarks.has(symbol);
    },
  };
}
