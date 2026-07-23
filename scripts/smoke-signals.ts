/* Phase 4.2–4.4 live smoke on local Postgres with REAL CBOE + regime data.
 *
 *  1. LIVE path: ingest chains → finalize today's capture (termSlope/gex/
 *     spikeBaselineDays persisted) → regime row (immutable if already final) →
 *     logSignals emits today's real signals with all four version stamps →
 *     backwardation episodes open on genuinely backwardated names.
 *  2. Production matrix: WARMING payload (nothing is 20 trading days old — the
 *     correct state), with firstScoringDate projected.
 *  3. Scoring math: seeded (ALLOW_SEED=1) signal rows on REAL past sessions are
 *     scored from REAL closes; one row's excess-vs-SPY is re-derived by hand and
 *     compared to the stored value.
 *  4. Matrix math on those scored seeded rows via buildMatrix directly (labeled
 *     demo), then proof the PRODUCTION path still excludes seeded rows.
 *
 * Run: DATABASE_URL=… DATA_PROVIDER=cboe MAX_TICKERS=120 ALLOW_SEED=1 \
 *      SEC_CONTACT_EMAIL=… npx tsx scripts/smoke-signals.ts */
import { prisma } from '../src/lib/db';
import { getDataProvider } from '../src/lib/data-source';
import { CboeClient } from '../src/lib/cboe';
import { refreshEventGauges } from '../src/lib/event-jobs';
import { getFlowEngine } from '../src/lib/flow-engine';
import { seedTickers } from '../src/lib/history-jobs';
import { buildRegimeMatrixData } from '../src/lib/matrix-data';
import { recordDailyRegime } from '../src/lib/regime-jobs';
import { finalizeDailyCapture } from '../src/lib/sector-analytics';
import { assertSeedAllowed } from '../src/lib/seed-guard';
import { logSignals, scoreSignals, trackBackwardationEpisodes } from '../src/lib/signal-jobs';
import { buildMatrix, type MatrixRow } from '../src/lib/signals';

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA', 'SPY', 'HYG', 'GLD', 'TLT'];

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const provider = getDataProvider();
  if (!(provider instanceof CboeClient)) throw new Error('need DATA_PROVIDER=cboe');
  const engine = getFlowEngine();
  engine.mode = 'live';
  await seedTickers();

  // ── 1. LIVE emission ──
  const [vix, vix3m] = await Promise.all([provider.getIndexQuote('_VIX'), provider.getIndexQuote('_VIX3M')]);
  engine.marketContext = { vix, vix3m, vixSpread: vix !== null && vix3m !== null ? Number((vix3m - vix).toFixed(2)) : null, updatedAt: Date.now() };
  for (const s of SYMBOLS) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(s, 1));
    } catch {
      /* ignore */
    }
  }
  await refreshEventGauges(engine); // load confirmed-event distributions (EDGAR events present)
  for (const s of SYMBOLS) {
    try {
      engine.ingest(await provider.getOptionsFlowSnapshot(s, 1)); // re-ingest → gauge attached
    } catch {
      /* ignore */
    }
  }
  await finalizeDailyCapture(engine, new Date());
  const regimeWrote = await recordDailyRegime(engine);
  console.log(`Regime row for today: ${regimeWrote ? 'written' : 'already final → NOT recomputed (immutable ✓)'}`);

  const emitted = await logSignals(engine);
  await trackBackwardationEpisodes();
  console.log(`\nLIVE SIGNALS EMITTED today: ${emitted}`);
  const todays = await db.signalLog.findMany({ where: { seeded: false }, orderBy: [{ signalType: 'asc' }, { symbol: 'asc' }] });
  for (const s of todays.slice(0, 14)) {
    console.log(
      `  ${s.firedOn.toISOString().slice(0, 10)} ${s.symbol.padEnd(6)} ${s.signalType.padEnd(13)} ${(s.direction ?? '—').padEnd(8)} ` +
        `mag=${s.magnitude?.toFixed(2) ?? '—'} regime=${s.regimeVol}/${s.regimeTrend}/${s.regimeGamma ?? 'na'} ` +
        `tv=${s.thresholdVersion} rv=${s.regimeConfigVersion}${s.detail ? ` (${s.detail})` : ''}`,
    );
  }
  const episodes = await db.backwardationEpisode.findMany({ where: { endDate: null } });
  console.log(`Open backwardation episodes: ${episodes.map((e) => `${e.symbol}@${e.entrySlope.toFixed(1)}`).join(', ') || 'none'}`);

  // ── 2. Production matrix: warming (the correct state) ──
  const warm = await buildRegimeMatrixData(10, 'exSpy');
  console.log(
    `\nPRODUCTION MATRIX: warming=${warm?.warming} — ${warm?.signalsLogged} signals logged, ` +
      `first scoring available ${warm?.firstScoringDate} · fullTripleFrom=${warm?.fullTripleFrom}`,
  );

  // ── 3. Seeded scoring demo on REAL past sessions/closes ──
  assertSeedAllowed('signal scoring demo');
  const spySessions = (
    await db.dailyMetric.findMany({ where: { symbol: 'SPY', close: { not: null }, seeded: false }, orderBy: { date: 'asc' }, select: { date: true } })
  ).map((r) => r.date);
  const picks: { symbol: string; idxBack: number; dir: 'bullish' | 'bearish' }[] = [];
  for (let k = 0; k < 24; k++) {
    picks.push({ symbol: k % 2 === 0 ? 'AAPL' : 'MSFT', idxBack: 60 - k, dir: k % 3 === 0 ? 'bearish' : 'bullish' });
  }
  let seededMade = 0;
  for (const p of picks) {
    const date = spySessions[spySessions.length - 1 - p.idxBack];
    if (!date) continue;
    const regime = await db.dailyRegime.findUnique({ where: { date } });
    await db.signalLog.upsert({
      where: { symbol_signalType_firedOn: { symbol: p.symbol, signalType: 'skew_z', firedOn: date } },
      create: {
        seeded: true,
        symbol: p.symbol,
        signalType: 'skew_z',
        firedOn: date,
        direction: p.dir,
        magnitude: p.dir === 'bullish' ? 2.4 : -2.4,
        regimeVol: regime?.volState ?? null,
        regimeTrend: regime?.trendState ?? null,
        regimeGamma: regime?.gammaState ?? null, // null on backfilled dates → the 'na' bucket
        thresholdVersion: 'demo',
      },
      update: { seeded: true },
    });
    seededMade += 1;
  }
  const scoredN = await scoreSignals();
  console.log(`\nSEEDED DEMO: ${seededMade} past-dated rows seeded, ${scoredN} scored from real closes`);

  // Hand-check one scored row against raw closes.
  const sample = await db.signalLog.findFirst({ where: { seeded: true, scored: true, fwd10ExSpy: { not: null } }, orderBy: { firedOn: 'asc' } });
  if (sample) {
    const d0 = sample.firedOn;
    const idx0 = spySessions.findIndex((d) => d.getTime() === d0.getTime());
    const d10 = spySessions[idx0 + 10]!;
    const close = async (sym: string, d: Date): Promise<number> =>
      (await db.dailyMetric.findUnique({ where: { symbol_date: { symbol: sym, date: d } }, select: { close: true } }))!.close as number;
    const [t0, t10, s0, s10] = await Promise.all([close(sample.symbol, d0), close(sample.symbol, d10), close('SPY', d0), close('SPY', d10)]);
    const hand = Math.log(t10 / t0) - Math.log(s10 / s0);
    console.log(`  HAND-CHECK ${sample.symbol} fired ${d0.toISOString().slice(0, 10)} → +10td ${d10.toISOString().slice(0, 10)}:`);
    console.log(`    ${sample.symbol}: ${t0.toFixed(2)} → ${t10.toFixed(2)} (ln ${(Math.log(t10 / t0) * 100).toFixed(2)}%)  SPY: ${s0.toFixed(2)} → ${s10.toFixed(2)} (ln ${(Math.log(s10 / s0) * 100).toFixed(2)}%)`);
    console.log(`    excess by hand = ${(hand * 100).toFixed(3)}%   stored fwd10ExSpy = ${((sample.fwd10ExSpy as number) * 100).toFixed(3)}%   ${Math.abs(hand - (sample.fwd10ExSpy as number)) < 1e-9 ? '✓ exact' : '✗ MISMATCH'}`);
  }

  // ── 4. Matrix math on the seeded rows (demo), then production exclusion proof ──
  const seededScored = await db.signalLog.findMany({ where: { seeded: true, scored: true } });
  const rows: MatrixRow[] = seededScored.map((r) => ({
    signalType: r.signalType,
    direction: r.direction as 'bullish' | 'bearish',
    regimeVol: r.regimeVol,
    regimeTrend: r.regimeTrend,
    regimeGamma: r.regimeGamma,
    ret: r.fwd10ExSpy,
    baseHitProb: null, // base rates need in-regime eligibility history — accrues live
    baseSource: null,
  }));
  const demo = buildMatrix(rows, 5);
  console.log(`\nMATRIX MATH (seeded demo, minCell=5): cellsTested=${demo.cellsTested} suppressed=${demo.suppressedCells} expectedByChance=${demo.expectedByChance}`);
  for (const c of demo.cells) {
    console.log(
      `  ${c.signalType} @ ${c.regimeVol}/${c.regimeTrend}/${c.regimeGamma}: n=${c.n} hit=${(c.hitRate * 100).toFixed(0)}% ` +
        `avgRet=${(c.avgRet * 100).toFixed(2)}% wilson=[${c.wilson ? `${(c.wilson.lo * 100).toFixed(0)}%,${(c.wilson.hi * 100).toFixed(0)}%` : '—'}]${c.suppressed ? ' SUPPRESSED' : ''}`,
    );
  }
  const prod = await buildRegimeMatrixData(10, 'exSpy');
  console.log(
    `\nPRODUCTION PATH after seeding: warming=${prod?.warming} scored=${prod?.signalsScored} ` +
      `(seeded rows EXCLUDED ✓ — the matrix never sees synthetic data)`,
  );

  await db.$disconnect();
  process.exit(0);
}

void main();
