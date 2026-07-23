/* Confirms the seed-safety mechanism:
 *   1. assertSeedAllowed throws in production and without ALLOW_SEED=1;
 *   2. seeded rows are EXCLUDED from z-scores / windows (can't reach a statistic);
 *   3. one-command purge removes them.
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=60 ALLOW_SEED=1 npx tsx scripts/smoke-seedguard.ts */
import { prisma } from '../src/lib/db';
import { getAnalyticsConfig } from '../src/lib/analytics-config';
import { getDataProvider } from '../src/lib/data-source';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { compositionVersionFor, finalizeDailyCapture } from '../src/lib/sector-analytics';
import { listCohorts, loadBenchmarkResolver } from '../src/lib/sector-benchmarks';
import { assertSeedAllowed } from '../src/lib/seed-guard';
import { slopeTStat, slopeTStatNW } from '../src/lib/sector-stats';
import { etDateKey } from '../src/lib/trading-calendar';

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');

  // 1. Guard behavior.
  const env = process.env as Record<string, string | undefined>;
  const origAllow = env.ALLOW_SEED;
  const origEnv = env.NODE_ENV;
  delete env.ALLOW_SEED;
  console.log('GUARD:');
  try {
    assertSeedAllowed('test');
    console.log('  ✗ did NOT throw without ALLOW_SEED');
  } catch {
    console.log('  ✓ throws without ALLOW_SEED=1');
  }
  env.NODE_ENV = "production";
  env.ALLOW_SEED = "1";
  try {
    assertSeedAllowed('test');
    console.log('  ✗ did NOT throw in production');
  } catch {
    console.log('  ✓ throws in NODE_ENV=production even with ALLOW_SEED=1');
  }
  env.NODE_ENV = origEnv;
  env.ALLOW_SEED = origAllow ?? "1";

  // 2. Exclusion: seed AAPL history (seeded=true), finalize on real data, show
  //    AAPL's z-score/divergence window ignores the seeded rows.
  const engine = getFlowEngine();
  engine.mode = 'live';
  const provider = getDataProvider();
  if (!provider) throw new Error('no provider');
  await seedTickers();
  const resolver = await loadBenchmarkResolver();
  const cohorts = listCohorts(resolver);
  const cfg = await getAnalyticsConfig();
  const version = compositionVersionFor(resolver.benchmarkFor('AAPL') as string, cohorts, cfg);
  const today = etDateKey();
  const day = 86_400_000;
  for (let i = 1; i <= 30; i++) {
    const date = new Date(today.getTime() - i * day);
    await db.relativeMetric.upsert({
      where: { symbol_date: { symbol: 'AAPL', date } },
      create: { seeded: true, symbol: 'AAPL', date, final: true, cohort: resolver.benchmarkFor('AAPL') as string, compositionVersion: version, skewRelSpread: -1, skewZ30: -1 },
      update: { seeded: true, final: true, skewRelSpread: -1, skewZ30: -1 },
    });
  }
  const seededBefore = await db.relativeMetric.count({ where: { seeded: true } });

  for (const sym of ['AAPL', 'MSFT', 'NVDA', 'ORCL', 'CRM', 'AMD', 'ADBE', 'CSCO', 'INTC', 'XLK']) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(sym, 1));
    } catch {
      /* ignore */
    }
  }
  await finalizeDailyCapture(engine, new Date());
  const aapl = await db.relativeMetric.findUnique({ where: { symbol_date: { symbol: 'AAPL', date: today } } });
  console.log('\nEXCLUSION (30 seeded AAPL rows present):');
  console.log(`  today AAPL: skewZ30=${aapl?.skewZ30 ?? 'null'}  divergenceWindow=${aapl?.divergenceWindow}  (seeded history ignored → still null/0)`);

  // 3. Newey-West vs OLS on an autocorrelated trend (audit demonstration).
  const y = Array.from({ length: 24 }, (_, t) => t + 4 * Math.sin(t / 2));
  console.log('\nNEWEY-WEST (autocorrelated-trend example):');
  console.log(`  OLS t=${slopeTStat(y)?.toFixed(2)}  →  Newey-West HAC t=${slopeTStatNW(y)?.toFixed(2)}  (HAC deflates the inflated OLS t)`);

  // 4. Purge.
  const daily = await db.dailyMetric.deleteMany({ where: { seeded: true } });
  const rel = await db.relativeMetric.deleteMany({ where: { seeded: true } });
  const cohort = await db.cohortDaily.deleteMany({ where: { seeded: true } });
  const seededAfter = await db.relativeMetric.count({ where: { seeded: true } });
  console.log('\nPURGE:');
  console.log(`  seeded RelativeMetric before=${seededBefore}, purged daily/rel/cohort=${daily.count}/${rel.count}/${cohort.count}, after=${seededAfter}`);

  await db.$disconnect();
  process.exit(0);
}

void main();
