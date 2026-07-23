/* Phase 2 wiring smoke: inverse config, IV-direction OI tiebreaker, divergence.
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=40 npx tsx scripts/smoke-phase2.ts */
import { prisma } from '../src/lib/db';
import { assertSeedAllowed } from '../src/lib/seed-guard';
import { getAnalyticsConfig } from '../src/lib/analytics-config';
import { getDataProvider } from '../src/lib/data-source';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { loadInstrumentConfigs } from '../src/lib/interpretation';
import { compositionVersionFor, finalizeDailyCapture, loadLatestIntoEngine } from '../src/lib/sector-analytics';
import { listCohorts, loadBenchmarkResolver } from '../src/lib/sector-benchmarks';
import { etDateKey } from '../src/lib/trading-calendar';

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const engine = getFlowEngine();
  engine.mode = 'live';
  const provider = getDataProvider();
  if (!provider) throw new Error('no provider');
  assertSeedAllowed('smoke'); // refuses in prod / without ALLOW_SEED=1
  await seedTickers();

  // Load inverse/leverage config.
  for (const [s, c] of await loadInstrumentConfigs()) engine.instruments.set(s, c);
  console.log('INVERSE CONFIG:', JSON.stringify(engine.instruments.get('SQQQ')), '(SQQQ)');

  const resolver = await loadBenchmarkResolver();
  const cohorts = listCohorts(resolver);
  const cfg = await getAnalyticsConfig();
  const version = compositionVersionFor(resolver.benchmarkFor('AAPL') as string, cohorts, cfg);
  const day = 86_400_000;
  // Anchor on the ET date finalize will use (not UTC), so the seed doesn't
  // collide with today's finalized row and the query lines up.
  const today = etDateKey();

  // Divergence scenario for AAPL: 20 prior days of RISING close + FALLING skew-z
  // (and skewRelSpread so today's z computes) → expect 'distribution'.
  for (let i = 20; i >= 1; i--) {
    const date = new Date(today.getTime() - i * day);
    const close = 100 + (20 - i) * 1.0; // rising 100→119
    const skewRel = 1.0 - (20 - i) * 0.1; // falling +1.0 → -0.9
    await db.dailyMetric.upsert({
      where: { symbol_date: { symbol: 'AAPL', date } },
      create: { seeded: true, symbol: 'AAPL', date, close, final: true, historicalCloseOnly: false, putOI: 2_000_000, callOI: 2_000_000, rrSkew: -2, iv30: 30 },
      update: { seeded: true, close, final: true, putOI: 2_000_000, callOI: 2_000_000 },
    });
    await db.relativeMetric.upsert({
      where: { symbol_date: { symbol: 'AAPL', date } },
      create: { seeded: true, symbol: 'AAPL', date, final: true, cohort: version && resolver.benchmarkFor('AAPL')!, compositionVersion: version, skewRelSpread: skewRel, skewZ30: skewRel },
      update: { seeded: true, final: true, cohort: resolver.benchmarkFor('AAPL')!, compositionVersion: version, skewRelSpread: skewRel, skewZ30: skewRel },
    });
  }

  // Manually prime AAPL's vol context so the live OI tiebreaker can classify:
  // yesterday callOI 1000, putOI 1000, skew -2. Today's live callOI/putOI vs these.
  engine.volContext.set('AAPL', { ivRank: null, hv20: null, prevTotalOI: 2000, prevPutOI: 1000, prevCallOI: 1000, prevRrSkew: -2 });

  // Ingest live AAPL and read the OI signals.
  engine.ingest(await provider.getOptionsFlowSnapshot('AAPL', 1));
  const aaplFlow = engine.getFlow('AAPL');
  console.log('\nOI TIEBREAKER (AAPL, live vs seeded prior day):');
  console.log('  calls:', JSON.stringify(aaplFlow?.oiSignals?.call));
  console.log('  puts :', JSON.stringify(aaplFlow?.oiSignals?.put));

  // Ingest the rest so finalize has a full engine, then finalize.
  for (const sym of ['MSFT', 'NVDA', 'ORCL', 'CRM', 'AMD', 'ADBE', 'CSCO', 'INTC', 'XLK']) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(sym, 1));
    } catch {
      /* ignore */
    }
  }
  await finalizeDailyCapture(engine, new Date());
  await loadLatestIntoEngine(engine);

  const aaplRel = await db.relativeMetric.findUnique({ where: { symbol_date: { symbol: 'AAPL', date: today } } });
  console.log('\nDIVERGENCE (AAPL):');
  console.log(
    `  type=${aaplRel?.divergenceType}  priceSlope=${aaplRel?.priceTrendSlope} (t=${aaplRel?.priceTrendT})  ` +
      `skewZslope=${aaplRel?.skewTrendSlope} (t=${aaplRel?.skewTrendT})  window=${aaplRel?.divergenceWindow}`,
  );
  console.log('  surfaced to engine:', engine.sectorRelatives.get('AAPL')?.divergence);

  await db.$disconnect();
  process.exit(0);
}

void main();
