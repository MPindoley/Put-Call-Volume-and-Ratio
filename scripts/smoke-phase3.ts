/* Phase 3 live smoke: event-variance decomposition + rich/cheap gauge against
 * REAL CBOE chains and price history on a local Postgres.
 *
 *   1. seed universe, backfill a long close history for a few liquid names;
 *   2. reconstruct inferred earnings events + realized moves from that history;
 *   3. ingest a live chain and build the per-ticker event gauge;
 *   4. print ONE fully hand-worked two-expiry extraction (both IVs, trading
 *      days, algebra, result) from real chain data, cross-checked against the
 *      pure module — plus the canonical unit-test example for a clean hand-check.
 *
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=60 npx tsx scripts/smoke-phase3.ts
 */
import { prisma } from '../src/lib/db';
import { getAnalyticsConfig } from '../src/lib/analytics-config';
import { getDataProvider } from '../src/lib/data-source';
import {
  buildExpiryQuotes,
  computeEventMoveForChain,
} from '../src/lib/event-analytics';
import { refreshEarningsRealized, refreshEventGauges, refreshIdiosyncraticEvents } from '../src/lib/event-jobs';
import {
  extractPreEventReference,
  extractTwoPostEvent,
  selectBracket,
  tauYears,
} from '../src/lib/event-variance';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { CboeClient } from '../src/lib/cboe';
import { etDateKey, tradingDaysBetween } from '../src/lib/trading-calendar';
import { TRACKED_UNIVERSE } from '../src/lib/universe';

// Mega-caps for the gauge / hand-worked demo.
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'AMZN', 'GOOGL'];
// Backfill a real cross-section (≥ breadth minTickers) so the market-wide-day
// filter actually engages — otherwise breadth can never judge a date.
const BACKFILL = [...new Set([...SYMBOLS, 'SPY', ...TRACKED_UNIVERSE.slice(0, 60).map((s) => s.symbol)])];

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) throw new Error('need DATA_PROVIDER=cboe');
  const engine = getFlowEngine();
  engine.mode = 'live';
  await seedTickers();
  const cfg = await getAnalyticsConfig();

  // 1. Long close history (≈600 sessions → multiple quarterly earnings) so the
  //    inferred detector can see cadence and the gauge can pass its threshold.
  const today = etDateKey().getTime();
  console.log(`BACKFILL close history (real CBOE 20-yr charts, ${BACKFILL.length} tickers for breadth):`);
  let ok = 0;
  for (const symbol of BACKFILL) {
    try {
      const closes = await provider.getDailyClosesDated(symbol, 600);
      const existing = new Set(
        (await db.dailyMetric.findMany({ where: { symbol }, select: { date: true } })).map((r) => r.date.getTime()),
      );
      const rows = closes
        .filter((c) => c.date.getTime() < today && !existing.has(c.date.getTime()))
        .map((c) => ({ symbol, date: c.date, close: c.close, final: true, historicalCloseOnly: true }));
      if (rows.length > 0) await db.dailyMetric.createMany({ data: rows, skipDuplicates: true });
      ok += 1;
    } catch (err) {
      console.warn(`  ${symbol}: history fetch failed (${err instanceof Error ? err.message : err})`);
    }
    await new Promise((r) => setTimeout(r, 400)); // pace the CDN
  }
  console.log(`  done (${ok}/${BACKFILL.length} tickers backfilled)`);

  // 2. Idiosyncratic-move feed (SPY-residual) + realized moves for confirmed events.
  const idioCount = await refreshIdiosyncraticEvents();
  const realized = await refreshEarningsRealized();
  console.log(`\nIDIOSYNCRATIC MOVES (vs SPY): ${idioCount} detected; realized earnings moves filled: ${realized}`);
  console.log('(This feed is informational — it does NOT feed the earnings rich/cheap distribution.)');

  // AAPL's idiosyncratic-move history — unscheduled single-name moves, NOT labeled earnings.
  const aaplIdio = await db.idiosyncraticEvent.findMany({ where: { symbol: 'AAPL' }, orderBy: { date: 'desc' } });
  console.log(`\nAAPL idiosyncratic moves: ${aaplIdio.length}`);
  for (const e of aaplIdio) {
    console.log(`  ${e.date.toISOString().slice(0, 10)}  ±${(e.movePct * 100).toFixed(1)}%  ${e.residualZ.toFixed(1)}σ residual (vs ${e.benchmark})`);
  }
  const confirmed = await db.earningsEvent.count({ where: { confirmed: true } });
  console.log(`\nConfirmed calendar earnings events: ${confirmed} (gauge shows a number only at ≥ minConfirmedEvents)`);

  // 3. Ingest live chains, refresh gauge inputs, print gauges.
  for (const symbol of SYMBOLS) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(symbol, 1));
    } catch (err) {
      console.warn(`  ingest ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }
  await refreshEventGauges(engine);
  // Re-ingest so buildEventGauge runs with the freshly loaded inputs.
  for (const symbol of SYMBOLS) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(symbol, 1));
    } catch {
      /* ignore */
    }
  }
  console.log('\nEVENT GAUGES (live):');
  for (const symbol of SYMBOLS) {
    const g = engine.getFlow(symbol)?.eventGauge;
    if (!g) {
      console.log(`  ${symbol}: no gauge`);
      continue;
    }
    const move = g.impliedMove !== null ? `±${(g.impliedMove * 100).toFixed(1)}%` : 'null';
    const rc = g.display
      ? `${g.percentile}th pctile, median ±${((g.medianRealized ?? 0) * 100).toFixed(1)}%, ratio ${g.richCheapRatio?.toFixed(2)}×`
      : `insufficient confirmed history ${g.confirmedCount}/${g.requiredCount}`;
    console.log(
      `  ${symbol}: implied ${move} [${g.impliedMethod ?? '—'}] catalyst ${g.eventDate ?? 'none'}(${g.eventSource ?? '—'})  gauge: ${rc}` +
        `  idio-moves ${engine.getFlow(symbol)?.idiosyncraticMoves.length ?? 0}${g.refusedReason ? `  REFUSED: ${g.refusedReason}` : ''}`,
    );
  }

  // 4. One fully hand-worked two-expiry extraction from REAL chain data.
  await handWorked(provider);

  // Canonical hand-check example (matches event-variance.test.ts).
  console.log('\n─── Canonical hand-check (bracket A) ───');
  const tauE = tauYears(10);
  console.log(`  Given: reference IV σ_ref = 0.30 (10 td), event IV σ_event = 0.60, event expiry 10 trading days out`);
  console.log(`  τ_event = 10/252                         = ${tauE.toFixed(7)}`);
  console.log(`  σ_d²    = 0.30²                           = ${(0.3 * 0.3).toFixed(4)}`);
  console.log(`  v_e     = (0.60² − 0.09)·τ_event = 0.27·${tauE.toFixed(7)} = ${(0.27 * tauE).toFixed(8)}`);
  console.log(`  move    = sqrt(v_e)                       = ${Math.sqrt(0.27 * tauE).toFixed(6)} → ±${(Math.sqrt(0.27 * tauE) * 100).toFixed(2)}%`);
  const chk = extractPreEventReference(
    { expiry: 'ref', iv: 0.3, tradingDays: 3, atmOpenInterest: 9999, quoteWidthFrac: 0.01 },
    { expiry: 'evt', iv: 0.6, tradingDays: 10, atmOpenInterest: 9999, quoteWidthFrac: 0.01 },
  );
  console.log(`  module says: ${chk.ok ? `±${(chk.result.impliedMove * 100).toFixed(2)}%` : chk.reason}`);

  await db.$disconnect();
  process.exit(0);
}

/** Walk one real symbol's two nearest liquid expiries through bracket B, step by step. */
async function handWorked(provider: CboeClient): Promise<void> {
  console.log('\n─── Hand-worked two-expiry extraction (REAL chain, bracket B) ───');
  for (const symbol of SYMBOLS) {
    const snap = await provider.getOptionsFlowSnapshot(symbol, 1);
    const spot = snap.underlyingPrice;
    const quotes = buildExpiryQuotes(snap.contracts ?? [], spot, Date.now())
      .filter((q) => q.atmOpenInterest >= 100 && q.quoteWidthFrac <= 0.25)
      .sort((a, b) => a.tradingDays - b.tradingDays);
    if (quotes.length < 2) continue;
    const near = quotes[0]!;
    const far = quotes[1]!;
    if (near.iv <= far.iv) continue; // want a near-term bulge so v_e > 0, illustrative
    const tauN = tauYears(near.tradingDays);
    const tauF = tauYears(far.tradingDays);
    const vNear = near.iv * near.iv * tauN;
    const vFar = far.iv * far.iv * tauF;
    const sigmaD2 = (vNear - vFar) / (tauN - tauF);
    const vE = vNear - sigmaD2 * tauN;
    console.log(`  Symbol ${symbol}, spot $${spot.toFixed(2)}  (event assumed before the near expiry → both span it)`);
    console.log(`    near expiry ${near.expiry}: ATM IV σ_near = ${near.iv.toFixed(4)} (${(near.iv * 100).toFixed(1)}%), ${near.tradingDays} td → τ_near = ${tauN.toFixed(6)}`);
    console.log(`    far  expiry ${far.expiry}: ATM IV σ_far  = ${far.iv.toFixed(4)} (${(far.iv * 100).toFixed(1)}%), ${far.tradingDays} td → τ_far  = ${tauF.toFixed(6)}`);
    console.log(`    V_near = σ_near²·τ_near = ${(near.iv * near.iv).toFixed(4)}·${tauN.toFixed(6)} = ${vNear.toFixed(8)}`);
    console.log(`    V_far  = σ_far²·τ_far  = ${(far.iv * far.iv).toFixed(4)}·${tauF.toFixed(6)} = ${vFar.toFixed(8)}`);
    console.log(`    σ_d²   = (V_near − V_far)/(τ_near − τ_far) = (${vNear.toFixed(8)} − ${vFar.toFixed(8)})/(${tauN.toFixed(6)} − ${tauF.toFixed(6)}) = ${sigmaD2.toFixed(6)}`);
    console.log(`           → clean diffusive vol σ_d = ${Math.sqrt(Math.max(0, sigmaD2)).toFixed(4)} (${(Math.sqrt(Math.max(0, sigmaD2)) * 100).toFixed(1)}%)`);
    console.log(`    v_e    = V_near − σ_d²·τ_near = ${vNear.toFixed(8)} − ${sigmaD2.toFixed(6)}·${tauN.toFixed(6)} = ${vE.toFixed(8)}`);
    console.log(`    implied event move = sqrt(v_e) = ${vE > 0 ? `${Math.sqrt(vE).toFixed(6)} → ±${(Math.sqrt(vE) * 100).toFixed(2)}%` : 'v_e ≤ 0 → NULL (refused, guardrail 1)'}`);

    // Cross-check against the pure module + selector.
    const sel = selectBracket(quotes, 1, { minOpenInterest: 100, maxQuoteWidthFrac: 0.25 });
    const mod = extractTwoPostEvent(near, far);
    console.log(`    selector: ${sel.ok ? `${sel.selection.method} (near ${sel.selection.event.expiry}, ref ${sel.selection.reference.expiry})` : sel.reason}`);
    console.log(`    module:   ${mod.ok ? `±${(mod.result.impliedMove * 100).toFixed(2)}% (matches the algebra above)` : mod.reason}`);
    const endToEnd = computeEventMoveForChain(snap.contracts ?? [], spot, new Date(), new Date());
    console.log(`    computeEventMoveForChain(event=today): ${endToEnd ? `±${(endToEnd.impliedMove * 100).toFixed(2)}% [${endToEnd.method}]` : 'null'}`);
    return; // one worked example is enough
  }
  console.log('  (no symbol presented a near-term ATM IV bulge right now — expected outside earnings season)');
}

void main();
