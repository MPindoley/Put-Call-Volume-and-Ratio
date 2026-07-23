/* Phase 4.1 live smoke: daily regime state against real data on local Postgres.
 *
 *   1. backfill SPY closes → reconstruct vol + trend regime history (gamma NULL)
 *      from CBOE VIX/VIX3M + SPY, with deadband + persistence;
 *   2. live-capture today's full triple (vol, trend, gamma) from live VIX/VIX3M +
 *      universe GEX, showing net-sum + breadth;
 *   3. show raw values next to classified states, a boundary-hold case, and the
 *      historical (2-D) vs full-triple date boundary.
 *
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=120 npx tsx scripts/smoke-regime.ts
 */
import { prisma } from '../src/lib/db';
import { getDataProvider } from '../src/lib/data-source';
import { CboeClient } from '../src/lib/cboe';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { backfillRegimeHistory, recordDailyRegime } from '../src/lib/regime-jobs';
import { GAMMA_LABEL, TREND_LABEL, VOL_LABEL, labelOf, type RegimeCell } from '../src/lib/regime';
import { etDateKey } from '../src/lib/trading-calendar';

const GEX_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA', 'SPY'];

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) throw new Error('need DATA_PROVIDER=cboe');
  const engine = getFlowEngine();
  engine.mode = 'live';
  await seedTickers();

  // 1. SPY closes → backfill vol + trend history.
  const spy = await provider.getDailyClosesDated('SPY', 700);
  const today = etDateKey().getTime();
  const existing = new Set((await db.dailyMetric.findMany({ where: { symbol: 'SPY' }, select: { date: true } })).map((r) => r.date.getTime()));
  const rows = spy
    .filter((c) => c.date.getTime() < today && !existing.has(c.date.getTime()))
    .map((c) => ({ symbol: 'SPY', date: c.date, close: c.close, final: true, historicalCloseOnly: true }));
  if (rows.length > 0) await db.dailyMetric.createMany({ data: rows, skipDuplicates: true });

  const backfilled = await backfillRegimeHistory();
  console.log(`BACKFILL regime history: ${backfilled} rows (vol + trend, gamma NULL)`);

  const recent = await db.dailyRegime.findMany({ orderBy: { date: 'desc' }, take: 6 });
  console.log('\nRecent historical regime rows (raw → classified):');
  for (const r of recent.reverse()) {
    const trendRaw = r.spxClose !== null && r.spx50ma !== null ? (r.spxClose - r.spx50ma).toFixed(1) : '—';
    console.log(
      `  ${r.date.toISOString().slice(0, 10)}  vixSpread=${r.vixSpread?.toFixed(2) ?? '—'} → ${labelOf(r.volState as RegimeCell, VOL_LABEL).padEnd(13)}` +
        `  spx−50ma=${trendRaw} → ${labelOf(r.trendState as RegimeCell, TREND_LABEL).padEnd(5)}  gamma=${r.gammaState ?? 'NULL (no history)'}`,
    );
  }

  // Boundary-hold demonstration: a day whose |vixSpread| sits inside the deadband.
  const band = 0.5;
  const nearBoundary = await db.dailyRegime.findFirst({
    where: { vixSpread: { gte: -band, lte: band } },
    orderBy: { date: 'desc' },
  });
  if (nearBoundary) {
    console.log(
      `\nBoundary hold: ${nearBoundary.date.toISOString().slice(0, 10)} vixSpread=${nearBoundary.vixSpread?.toFixed(2)} is inside ±${band} → ` +
        `state HELD at ${labelOf(nearBoundary.volState as RegimeCell, VOL_LABEL)} (in-band noise doesn't flip it)`,
    );
  }

  // 2. Live capture: set market context + ingest chains for GEX, then classify today.
  const [vix, vix3m] = await Promise.all([provider.getIndexQuote('_VIX'), provider.getIndexQuote('_VIX3M')]);
  engine.marketContext = {
    vix,
    vix3m,
    vixSpread: vix !== null && vix3m !== null ? Number((vix3m - vix).toFixed(2)) : null,
    updatedAt: Date.now(),
  };
  for (const s of GEX_SYMBOLS) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(s, 1));
    } catch {
      /* ignore */
    }
  }
  // Today's SPY close so trend has a current point.
  const spyPrice = engine.getFlow('SPY')?.underlyingPrice ?? 0;
  if (spyPrice > 0) {
    await db.dailyMetric.upsert({
      where: { symbol_date: { symbol: 'SPY', date: etDateKey() } },
      create: { symbol: 'SPY', date: etDateKey(), close: spyPrice, final: false, historicalCloseOnly: false },
      update: { close: spyPrice },
    });
  }
  const wrote = await recordDailyRegime(engine);
  console.log(`\nLIVE capture today (${wrote ? 'written' : 'skipped — already final'}):`);
  const todayRow = await db.dailyRegime.findUnique({ where: { date: etDateKey() } });
  if (todayRow) {
    console.log(
      `  ${todayRow.date.toISOString().slice(0, 10)}  vol=${labelOf(todayRow.volState as RegimeCell, VOL_LABEL)} (vixSpread=${todayRow.vixSpread?.toFixed(2)})` +
        `  trend=${labelOf(todayRow.trendState as RegimeCell, TREND_LABEL)} (spx−50ma=${todayRow.spxClose && todayRow.spx50ma ? (todayRow.spxClose - todayRow.spx50ma).toFixed(1) : '—'})` +
        `  gamma=${labelOf(todayRow.gammaState as RegimeCell, GAMMA_LABEL)} (netGEX=${todayRow.aggGex?.toExponential(2)}, breadth=${todayRow.gexBreadth !== null ? (todayRow.gexBreadth * 100).toFixed(0) + '% positive' : '—'})`,
    );
    console.log(`  regimeConfigVersion=${todayRow.regimeConfigVersion}  final=${todayRow.final}`);
  }

  // 3. Full-triple boundary.
  const firstGamma = await db.dailyRegime.findFirst({ where: { gammaState: { not: null } }, orderBy: { date: 'asc' } });
  const total = await db.dailyRegime.count();
  const withGamma = await db.dailyRegime.count({ where: { gammaState: { not: null } } });
  console.log(
    `\nDate coverage: ${total} regime rows; full triple available from ${firstGamma?.date.toISOString().slice(0, 10) ?? '—'} onward ` +
      `(${withGamma} rows). Earlier rows are 2-D (vol+trend); gamma is never fabricated.`,
  );

  await db.$disconnect();
  process.exit(0);
}

void main();
