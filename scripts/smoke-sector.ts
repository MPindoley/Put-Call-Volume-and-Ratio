/* Live smoke test for the Phase 1 cohort-relative layer. Fetches real CBOE
 * chains, finalizes a pinned capture, and prints cohort aggregates + relatives.
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=90 npx tsx scripts/smoke-sector.ts */
import { prisma } from '../src/lib/db';
import { assertSeedAllowed } from '../src/lib/seed-guard';
import { getAnalyticsConfig } from '../src/lib/analytics-config';
import { getDataProvider } from '../src/lib/data-source';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { compositionVersionFor, finalizeDailyCapture } from '../src/lib/sector-analytics';
import { listCohorts, loadBenchmarkResolver } from '../src/lib/sector-benchmarks';
import { TRACKED_UNIVERSE } from '../src/lib/universe';

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const engine = getFlowEngine();
  engine.mode = 'live';
  const provider = getDataProvider();
  if (!provider) throw new Error('no provider');
  assertSeedAllowed('smoke'); // refuses in prod / without ALLOW_SEED=1
  await seedTickers();

  // AAPL's cohort is XLK (not overridden). Seed 25 realistic prior days stamped
  // with the SAME cohort + compositionVersion the live finalize will use, so the
  // guarded z-score picks them up: 25 ≥ zMinObs30 (20) but < zMinObs90 (60).
  const resolver = await loadBenchmarkResolver();
  const cohorts = listCohorts(resolver);
  const cfg = await getAnalyticsConfig();
  const aaplCohort = resolver.benchmarkFor('AAPL') as string;
  const version = compositionVersionFor(aaplCohort, cohorts, cfg);
  console.log(`AAPL cohort=${aaplCohort} version=${version}`);

  const day = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10));
  for (let i = 1; i <= 25; i++) {
    const date = new Date(today.getTime() - i * day);
    const skewRel = -1.0 + Math.sin(i * 1.7) * 0.8;
    await db.relativeMetric.upsert({
      where: { symbol_date: { symbol: 'AAPL', date } },
      create: { seeded: true, symbol: 'AAPL', date, final: true, cohort: aaplCohort, compositionVersion: version, skewRelSpread: skewRel },
      update: { seeded: true, final: true, cohort: aaplCohort, compositionVersion: version, skewRelSpread: skewRel },
    });
  }

  console.log(`fetching ${TRACKED_UNIVERSE.length} live CBOE chains…`);
  let n = 0;
  for (const { symbol } of TRACKED_UNIVERSE) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(symbol, 1));
      n++;
    } catch (err) {
      console.warn('  skip', symbol, err instanceof Error ? err.message : err);
    }
  }
  console.log(`ingested ${n} tickers`);

  const ok = await finalizeDailyCapture(engine, new Date());
  console.log(`finalizeDailyCapture → ${ok}\n`);

  console.log('COHORT AGGREGATES (finalized):');
  for (const s of await db.cohortDaily.findMany({ orderBy: { cohortLabel: 'asc' } })) {
    console.log(
      `  ${s.cohortLabel.padEnd(28)} n=${String(s.constituentCount).padStart(3)}  ` +
        `medIV=${fmt(s.medianIv30)}  IQR=${fmt(s.medianIqr)}  benchIV=${fmt(s.benchmarkIv30)}  ` +
        `disp=${fmt(s.dispersionProxy, 3)} [${s.dispersionWeightMethod ?? '—'}]  ver=${s.compositionVersion}`,
    );
  }

  const aapl = await db.relativeMetric.findUnique({ where: { symbol_date: { symbol: 'AAPL', date: today } } });
  console.log(
    `\nAAPL (cohort ${aapl?.cohort}): skewRel=${fmt(aapl?.skewRelSpread ?? null)}  ` +
      `skewZ30=${aapl?.skewZ30?.toFixed(2) ?? '—'}  skewZ90=${aapl?.skewZ90?.toFixed(2) ?? '—'}  windowDays=${aapl?.windowDays}`,
  );
  const semis = await db.cohortDaily.findUnique({ where: { cohort_date: { cohort: 'SMH', date: today } } });
  if (semis) console.log(`Semis cohort (SMH): n=${semis.constituentCount} medIV=${fmt(semis.medianIv30)} — proves NVDA-type names left XLK.`);
  await db.$disconnect();
  process.exit(0);
}

function fmt(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

void main();
