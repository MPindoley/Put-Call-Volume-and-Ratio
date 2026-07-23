/* Live EDGAR smoke: confirm real earnings history from SEC 8-K Item 2.02 on a
 * local Postgres, with report timing derived from the acceptance timestamp and
 * realized moves measured on the correct session.
 *
 *   1. fetch AAPL/MSFT filings from SEC (cached in EdgarCache);
 *   2. backfill closes so realized moves can be measured;
 *   3. seed a forward candidate near a real report → show EDGAR auto-confirms it;
 *   4. run refreshEdgarConfirmations → print confirmed events, derived timing,
 *      acceptance timestamp, and realized move on the matched session.
 *
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe SEC_CONTACT_EMAIL=you@example.com \
 *      MAX_TICKERS=60 npx tsx scripts/smoke-edgar.ts
 */
import { prisma } from '../src/lib/db';
import { getDataProvider } from '../src/lib/data-source';
import { invalidateAnalyticsConfig } from '../src/lib/analytics-config';
import { CboeClient } from '../src/lib/cboe';
import { EdgarClient } from '../src/lib/edgar';
import { refreshEdgarConfirmations } from '../src/lib/event-jobs';
import { seedTickers } from '../src/lib/history-jobs';
import { etDateKey } from '../src/lib/trading-calendar';

const TICKERS = ['AAPL', 'MSFT'];

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) throw new Error('need DATA_PROVIDER=cboe (for close backfill)');
  await seedTickers();

  // 1. Raw EDGAR view (also warms the cache).
  const client = new EdgarClient(process.env.SEC_CONTACT_EMAIL, {
    async get(key) {
      const r = await db.edgarCache.findUnique({ where: { key } });
      return r?.json ?? null;
    },
    async put(key, json) {
      await db.edgarCache.upsert({ where: { key }, create: { key, json }, update: { json, fetchedAt: new Date() } });
    },
  });
  const cikMap = await client.cikMap();
  console.log('RAW EDGAR (8-K Item 2.02):');
  for (const t of TICKERS) {
    const cik = cikMap.get(t)!;
    const events = await client.earningsEvents(cik, 45);
    console.log(`  ${t} (CIK ${cik}): ${events.filter((e) => e.confirmed).length} confirmed, ${events.filter((e) => e.pendingReview).length} pending-review`);
    for (const e of events.slice(0, 4)) {
      console.log(`    ${e.reportDate}  ${e.timing.padEnd(8)}  accepted ${e.acceptedAt.toISOString()}  ${e.confirmed ? 'CONFIRMED' : 'pending-review'}`);
    }
  }

  // 2. Backfill closes (for realized moves).
  const today = etDateKey().getTime();
  for (const t of TICKERS) {
    const closes = await provider.getDailyClosesDated(t, 600);
    const existing = new Set((await db.dailyMetric.findMany({ where: { symbol: t }, select: { date: true } })).map((r) => r.date.getTime()));
    const rows = closes
      .filter((c) => c.date.getTime() < today && !existing.has(c.date.getTime()))
      .map((c) => ({ symbol: t, date: c.date, close: c.close, final: true, historicalCloseOnly: true }));
    if (rows.length > 0) await db.dailyMetric.createMany({ data: rows, skipDuplicates: true });
  }

  // 3. Seed a forward candidate a couple days off a real AAPL report → auto-confirm.
  const aaplCik = cikMap.get('AAPL')!;
  const realReport = (await client.earningsEvents(aaplCik, 45)).find((e) => e.confirmed)!;
  const off = new Date(new Date(`${realReport.reportDate}T00:00:00Z`).getTime() - 2 * 86_400_000);
  await db.earningsEvent.upsert({
    where: { symbol_date: { symbol: 'AAPL', date: off } },
    create: { symbol: 'AAPL', date: off, source: 'forward', confirmed: false, reportTiming: 'unknown' },
    update: { source: 'forward', confirmed: false },
  });
  console.log(`\nSeeded FORWARD candidate AAPL ${off.toISOString().slice(0, 10)} (2 days before the real ${realReport.reportDate} report)`);

  // 4. Configure the priority list + confirm.
  await db.analyticsConfig.upsert({ where: { id: 1 }, create: { id: 1, edgarTickers: TICKERS }, update: { edgarTickers: TICKERS } });
  invalidateAnalyticsConfig();
  const res = await refreshEdgarConfirmations();
  console.log(`\nrefreshEdgarConfirmations → confirmed=${res.confirmed}, pending=${res.pending}`);

  const stored = await db.earningsEvent.findMany({ where: { symbol: 'AAPL', source: 'edgar' }, orderBy: { date: 'desc' }, take: 6 });
  console.log('\nStored AAPL EDGAR events (realized on the derived session):');
  for (const e of stored) {
    console.log(
      `  ${e.date.toISOString().slice(0, 10)}  ${e.reportTiming.padEnd(8)}  confirmed=${e.confirmed}  pendingReview=${e.pendingReview}  ` +
        `realized=${e.realizedMovePct !== null ? `±${(e.realizedMovePct * 100).toFixed(1)}%` : 'n/a'}  timingUncertain=${e.realizedTimingUncertain}  accepted=${e.acceptedAt?.toISOString() ?? '—'}`,
    );
  }
  const dup = await db.earningsEvent.count({ where: { symbol: 'AAPL', date: off } });
  console.log(`\nForward candidate at ${off.toISOString().slice(0, 10)} still present as a separate row? ${dup > 0 ? 'YES (bug)' : 'no — superseded in place ✓'}`);
  const confirmedCount = await db.earningsEvent.count({ where: { symbol: 'AAPL', confirmed: true } });
  console.log(`Confirmed AAPL events now feeding the gauge distribution: ${confirmedCount}`);

  // Cache check: a second call hits EdgarCache, not SEC.
  const cacheRows = await db.edgarCache.count();
  console.log(`\nEdgarCache rows: ${cacheRows} (CIK map + per-CIK submissions — backfill won't re-hit SEC)`);

  await db.$disconnect();
  process.exit(0);
}

void main();
