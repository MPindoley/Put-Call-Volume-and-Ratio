/**
 * Point-in-time integration harness (review proposal 1). Runs against a throwaway
 * Postgres; SKIPPED unless RUN_DB_TESTS=1 (and DATABASE_URL points at that DB), so
 * the default pure suite is unaffected. Push the schema first: `prisma db push`.
 *
 * Four assertions the pure suite structurally cannot make:
 *   (a) a provisional row is never used as a scored signal's forward endpoint;
 *   (b) a seeded row never reaches the regime matrix;
 *   (c) ?demo=1 returns 403 under NODE_ENV=production (seed-guard on the route);
 *   (d) a scored SignalLog row's forward endpoint is always a FINALIZED close.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { scoreSignals } from './signal-jobs';
import { buildRegimeMatrixData } from './matrix-data';
import { thresholdVersion } from './signals';
import { regimeConfigVersion } from './regime';
import { getAnalyticsConfig } from './analytics-config';
import { GET as regimeGET } from '@/app/api/accuracy/regime/route';
import { GET as learningGET } from '@/app/api/learning/route';
import { getLearningReport, loadConvictionsIntoEngine, refreshEdgeBooks } from './learning-jobs';
import { GET as reportGET } from '@/app/api/learning/report/route';
import { loadTrackRecord } from './learning-data';
import { getFlowEngine } from './flow-engine';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;

// 25 consecutive weekday sessions (Mon 2026-03-02 …); weekends skipped.
function weekdays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date(Date.UTC(2026, 2, 2));
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function wipe(): Promise<void> {
  await db.edgeBook.deleteMany({});
  await db.signalLog.deleteMany({});
  await db.dailyMetric.deleteMany({});
  await db.dailyRegime.deleteMany({});
  // DailyMetric.symbol FKs to Ticker — ensure the fixtures' tickers exist.
  await db.ticker.createMany({
    data: [
      { symbol: 'SPY', sector: 'ETF' },
      { symbol: 'AAPL', sector: 'Technology' },
      { symbol: 'XLF', sector: 'ETF' },
      { symbol: 'XLK', sector: 'ETF' },
      { symbol: 'MSFT', sector: 'Technology' },
      { symbol: 'GHOST', sector: 'Financials' }, // halted mid-history: price freezes
      // Delisted name: persisted with its sector, absent from the live universe.
      { symbol: 'DEADCO', sector: 'Financials' },
    ],
    skipDuplicates: true,
  });
}

/** 60-session learning history: AAPL hits 3/4, MSFT 1/2 (bullish pc_extreme), + tonight's pending signals. */
async function seedLearningHistory(): Promise<{ days: Date[]; N: number; tv: string; rv: string }> {
  const cfg = await getAnalyticsConfig();
  const tv = thresholdVersion(cfg);
  const rv = regimeConfigVersion({
    volDeadband: cfg.regimeVolDeadband,
    trendDeadbandPct: cfg.regimeTrendDeadbandPct,
    gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
    persistDays: cfg.regimePersistDays,
  });
  const N = 60;
  const days = weekdays(N);
  const metrics = [];
  for (let i = 0; i < N; i++) {
    const row = (symbol: string, close: number, oi: boolean) => ({
      symbol,
      date: days[i]!,
      close,
      final: true,
      historicalCloseOnly: false,
      ...(oi ? { putOI: 1000, callOI: 1000 } : {}),
    });
    metrics.push(row('SPY', 500, false)); // flat market → excess = raw
    metrics.push(row('XLK', 200, false));
    // Oscillating names: 10-session forward returns change sign → base ≈ 50%.
    metrics.push(row('AAPL', 100 + 5 * Math.sin(i / 3), true));
    metrics.push(row('MSFT', 100 + 5 * Math.cos(i / 3), true));
  }
  await db.dailyMetric.createMany({ data: metrics });
  await db.dailyRegime.createMany({
    data: days.map((date) => ({ date, volState: 'pos', trendState: 'pos', gammaState: 'pos', regimeConfigVersion: rv, final: true })),
  });
  // 40 graded bullish pc_extreme signals each: AAPL hits 3 of 4, MSFT 1 of 2.
  const sigs = [];
  for (let i = 0; i < 40; i++) {
    for (const [symbol, hit] of [['AAPL', i % 4 !== 0], ['MSFT', i % 2 === 0]] as const) {
      sigs.push({
        symbol,
        firedOn: days[i]!,
        signalType: 'pc_extreme',
        direction: 'bullish',
        thresholdVersion: tv,
        regimeConfigVersion: rv,
        regimeVol: 'pos',
        regimeTrend: 'pos',
        regimeGamma: 'pos',
        scored: true,
        fwd10ExSpy: hit ? 0.02 : -0.02,
      });
    }
  }
  // Tonight's signals: fired on the latest session, not graded yet.
  for (const symbol of ['AAPL', 'MSFT']) {
    sigs.push({
      symbol,
      firedOn: days[N - 1]!,
      signalType: 'pc_extreme',
      direction: 'bullish',
      thresholdVersion: tv,
      regimeConfigVersion: rv,
      regimeVol: 'pos',
      regimeTrend: 'pos',
      regimeGamma: 'pos',
      scored: false,
      fwd10ExSpy: null as unknown as number,
    });
  }
  await db.signalLog.createMany({ data: sigs });

  return { days, N, tv, rv };
  }

describe.skipIf(!RUN)('PIT integration (RUN_DB_TESTS=1)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('(a)+(d): a provisional endpoint is never scored; the finalized close is used once it lands', async () => {
    const cfg = await getAnalyticsConfig();
    const tv = thresholdVersion(cfg);
    const rv = regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    });
    const days = weekdays(25);
    // SPY + AAPL finalized closes for D0..D19; D20 starts PROVISIONAL (close null, liveClose set).
    for (let i = 0; i < 21; i++) {
      const provisional = i === 20;
      for (const [symbol, base] of [['SPY', 500], ['AAPL', 100]] as const) {
        const px = base + i; // strictly increasing so the sign is deterministic
        await db.dailyMetric.create({
          data: {
            symbol,
            date: days[i]!,
            close: provisional ? null : px,
            liveClose: provisional ? px : null,
            final: !provisional,
            historicalCloseOnly: false,
          },
        });
      }
    }
    const signal = await db.signalLog.create({
      data: {
        symbol: 'AAPL',
        firedOn: days[0]!,
        signalType: 'skew_z',
        direction: 'bullish',
        thresholdVersion: tv,
        regimeConfigVersion: rv,
        regimeVol: 'pos',
        regimeTrend: 'pos',
        regimeGamma: 'pos',
      },
    });

    // Endpoint D20 is provisional → the 20-td window is NOT scoreable yet.
    await scoreSignals();
    let row = await db.signalLog.findUniqueOrThrow({ where: { id: signal.id } });
    expect(row.scored).toBe(false);
    expect(row.fwd20Raw).toBeNull();

    // Finalize D20 with the OFFICIAL close, distinct from the provisional liveClose.
    for (const [symbol, base] of [['SPY', 500], ['AAPL', 100]] as const) {
      await db.dailyMetric.update({
        where: { symbol_date: { symbol, date: days[20]! } },
        data: { close: base + 20, final: true },
      });
    }
    await scoreSignals();
    row = await db.signalLog.findUniqueOrThrow({ where: { id: signal.id } });
    expect(row.scored).toBe(true);
    // fwd20Raw must equal ln(finalizedClose20 / close0) = ln(120/100).
    expect(row.fwd20Raw).toBeCloseTo(Math.log(120 / 100), 10);
  });

  it('(b): seeded rows never reach the matrix', async () => {
    const cfg = await getAnalyticsConfig();
    const tv = thresholdVersion(cfg);
    const rv = regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    });
    const days = weekdays(3);
    await db.dailyRegime.create({
      data: { date: days[0]!, volState: 'pos', trendState: 'pos', gammaState: 'pos', regimeConfigVersion: rv, final: true, seeded: true },
    });
    // 30 SEEDED, already-scored directional signals that would otherwise form a cell.
    for (let i = 0; i < 30; i++) {
      await db.signalLog.create({
        data: {
          seeded: true,
          symbol: 'AAPL',
          firedOn: new Date(Date.UTC(2026, 2, 2, 0, 0, i)), // distinct keys
          signalType: 'skew_z',
          direction: 'bullish',
          thresholdVersion: tv,
          regimeConfigVersion: rv,
          regimeVol: 'pos',
          regimeTrend: 'pos',
          regimeGamma: 'pos',
          scored: true,
          fwd10ExSpy: 0.02,
        },
      });
    }
    const data = await buildRegimeMatrixData(10, 'exSpy');
    expect(data).not.toBeNull();
    // Seeded rows are invisible → still warming, no cells.
    expect(data!.warming).toBe(true);
    expect(data!.matrix).toBeNull();
    expect(data!.signalsScored).toBe(0);
  });

  it('(e): survivorship — a name that stops trading is graded to its last close, gaps are not', async () => {
    const days = weekdays(30);
    const finalRow = (symbol: string, i: number, close: number) => ({
      symbol,
      date: days[i]!,
      close,
      final: true,
      historicalCloseOnly: false,
    });
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push(finalRow('SPY', i, 500 + i)); // canonical session calendar
      rows.push(finalRow('XLF', i, 40)); // flat sector benchmark
      if (i !== 20) rows.push(finalRow('AAPL', i, 100 + i)); // capture gap at 20, trades after
      if (i <= 7) rows.push(finalRow('DEADCO', i, 50 + 5 * i)); // acquired after session 7
    }
    await db.dailyMetric.createMany({ data: rows });

    const base = { thresholdVersion: 'tv', regimeConfigVersion: 'rv', direction: 'bullish' };
    // (1) Pending signal on the name that gets acquired inside its window.
    const dead = await db.signalLog.create({
      data: { ...base, symbol: 'DEADCO', firedOn: days[0]!, signalType: 'skew_z' },
    });
    // (2) Graded BEFORE terminal grading existed: blank returns, should be rescued.
    const legacy = await db.signalLog.create({
      data: { ...base, symbol: 'DEADCO', firedOn: days[1]!, signalType: 'divergence', scored: true },
    });
    // (3) Pending signal whose 20-day endpoint falls on a capture GAP.
    const gap = await db.signalLog.create({
      data: { ...base, symbol: 'AAPL', firedOn: days[0]!, signalType: 'skew_z' },
    });

    await scoreSignals();

    const d = await db.signalLog.findUniqueOrThrow({ where: { id: dead.id } });
    expect(d.scored).toBe(true);
    expect(d.terminalOn?.toISOString().slice(0, 10)).toBe(days[7]!.toISOString().slice(0, 10));
    expect(d.fwd20Raw).toBeCloseTo(Math.log(85 / 50), 10); // last close 50+5·7=85
    // Benchmarks measured to the same terminal date, not the scheduled one.
    expect(d.fwd20ExSpy).toBeCloseTo(Math.log(85 / 50) - Math.log(507 / 500), 10);
    // Sector benchmark recovered from the PERSISTED sector (Financials → XLF).
    expect(d.fwd20ExSector).toBeCloseTo(Math.log(85 / 50) - 0, 10);

    const l = await db.signalLog.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(l.terminalOn).not.toBeNull();
    expect(l.fwd20Raw).toBeCloseTo(Math.log(85 / 55), 10);

    const g = await db.signalLog.findUniqueOrThrow({ where: { id: gap.id } });
    expect(g.scored).toBe(true);
    expect(g.terminalOn).toBeNull(); // a gap is not a delisting
    expect(g.fwd20Raw).toBeNull(); // and is not papered over
    expect(g.fwd10Raw).toBeCloseTo(Math.log(110 / 100), 10); // other horizons unaffected

    // Idempotent: a second pass rewrites nothing.
    expect(await scoreSignals()).toBe(0);
  });

  it('(f): the edge book learns point-in-time, nightly and immutably', async () => {
    const { days, N } = await seedLearningHistory();

    const res = await refreshEdgeBooks();
    // First outcome is knowable at session 10 (fired 0 + horizon 10) → books 10..59.
    expect(res?.written).toBe(50);
    expect(res?.reconstructed).toBe(49); // only tonight's is live

    const books = await db.edgeBook.findMany({ orderBy: { asOf: 'asc' } });
    const latest = books[books.length - 1]!;
    expect(latest.reconstructed).toBe(false);
    expect(latest.rowsUsed).toBe(80); // every signal's outcome known by session 59
    expect(latest.rowsUnbased).toBe(0); // cohort (XLK) base rates filled in

    // Point-in-time: the book for session 20 knows only signals fired ≤ session 10
    // (22 of them) — and at that point the cohort's base rate rests on just 22
    // knowable days, under MIN_BASE_SAMPLE, so they are unbased: skipped, not
    // measured against noise.
    const at20 = books.find((b) => b.asOf.getTime() === days[20]!.getTime())!;
    expect(at20.rowsUsed + at20.rowsUnbased).toBe(22);
    expect(at20.rowsUsed).toBe(0);
    // By session 30, 42 knowable base days → based; signals fired ≤ 20 count.
    const at30b = books.find((b) => b.asOf.getTime() === days[30]!.getTime())!;
    expect(at30b.rowsUsed).toBe(42);

    // It learned that AAPL's signals are better than MSFT's — but shrunk.
    const nodes = latest.nodes as Record<string, { n: number; excess: number; nEff: number }>;
    const aapl = nodes['ticker:pc_extreme|bullish|pos|pos|Technology|AAPL']!;
    const msft = nodes['ticker:pc_extreme|bullish|pos|pos|Technology|MSFT']!;
    expect(aapl.n).toBe(40);
    expect(aapl.excess / aapl.nEff).toBeGreaterThan(msft.excess / msft.nEff);

    // Tonight's convictions are recorded for names with a signal that session.
    const at30 = books.find((b) => b.asOf.getTime() === days[30]!.getTime())!;
    const conv = at30.convictions as Record<string, { s: number; p: unknown[] }>;
    expect(Object.keys(conv).sort()).toEqual(['AAPL', 'MSFT']);
    expect(conv.AAPL!.s).toBeGreaterThan(conv.MSFT!.s);

    // Immutable + idempotent: a second run writes nothing.
    expect((await refreshEdgeBooks())?.written).toBe(0);

    // And the API reports what was learned.
    const body = await (await learningGET()).json();
    expect(body.books).toBe(50);
    const sig = body.learning.signals.find((x: { signalType: string }) => x.signalType === 'pc_extreme');
    expect(sig.direction).toBe('bullish');
    expect(sig.n).toBe(80);
    expect(sig.edge).toBeGreaterThan(0);
    expect(sig.edge).toBeLessThan(sig.raw); // shrunk toward zero

    // The engine shows tonight's learned conviction…
    const engine = getFlowEngine();
    await loadConvictionsIntoEngine(engine);
    const lastIso = days[N - 1]!.toISOString().slice(0, 10);
    const ca = engine.convictions.get('AAPL')!;
    const cm = engine.convictions.get('MSFT')!;
    expect(ca.asOf).toBe(lastIso);
    expect(ca.parts).toHaveLength(1);
    expect(ca.score).toBeGreaterThan(cm.score); // AAPL's record earned more weight

    // …and the ticker page shows the stock's memory.
    const tr = await loadTrackRecord(db, 'AAPL');
    expect(tr.bySignal).toEqual([
      expect.objectContaining({ signalType: 'pc_extreme', direction: 'bullish', graded: 40, hits: 30 }),
    ]);
    expect(tr.recent[0]).toEqual(expect.objectContaining({ firedOn: lastIso, pending: true }));
    expect(tr.learned).toHaveLength(1);
    expect(tr.learned[0]!.path.map((p) => p.level)).toEqual(['signal', 'regime', 'sector', 'ticker']);
    expect(tr.learned[0]!.path[3]!.n).toBe(40);
    expect(tr.note).toBeNull();
    engine.setConvictions(new Map()); // leave the singleton clean
  });

  it('(g): self-grading replays past convictions point-in-time; frozen prices are excluded', async () => {
    const { days, N, tv, rv } = await seedLearningHistory();
    // GHOST trades normally, then its price freezes at 42 for the last 30 sessions
    // (a halted name whose last snapshot kept being captured). Five "winning"
    // signals fired during the freeze must not count as evidence.
    await db.dailyMetric.createMany({
      data: days.map((date, i) => ({
        symbol: 'GHOST',
        date,
        close: i < 30 ? 40 + Math.sin(i) : 42,
        putOI: 1000,
        callOI: 1000,
        final: true,
        historicalCloseOnly: false,
      })),
    });
    await db.signalLog.createMany({
      data: [35, 36, 37, 38, 39].map((i) => ({
        symbol: 'GHOST',
        firedOn: days[i]!,
        signalType: 'pc_extreme',
        direction: 'bullish',
        thresholdVersion: tv,
        regimeConfigVersion: rv,
        regimeVol: 'pos',
        regimeTrend: 'pos',
        regimeGamma: 'pos',
        scored: true,
        fwd10ExSpy: 0.02,
      })),
    });
    await refreshEdgeBooks();

    const r = (await getLearningReport())!;
    expect(r.status.sessions.count).toBe(N);
    expect(r.status.books.total).toBe(50);
    expect(r.status.signals.graded).toBe(80); // AAPL + MSFT only
    expect(r.status.signals.pending).toBe(2); // tonight's
    expect(r.status.signals.excludedFrozen).toBe(5); // the ghost "wins"
    expect(r.status.frozen.top).toEqual([expect.objectContaining({ symbol: 'GHOST', sessions: 30 })]);
    expect(r.status.signals.nextMaturity! > days[N - 1]!.toISOString().slice(0, 10)).toBe(true);

    // Self-grading: convictions formed on sessions 10..49 (once evidence existed and
    // the outcome is now known), graded against what happened.
    const c = r.selfGrade;
    // Only sessions whose base rates rest on ≥ MIN_BASE_SAMPLE observations grade.
    expect(c.n).toBeGreaterThan(20);
    expect(c.n).toBeLessThanOrEqual(2 * 30); // ≤ two names × sessions 10..39 with signals
    expect(c.hitRate).toBeGreaterThan(0.5); // AAPL's 75% dominates the bullish leans
    expect(c.skill).not.toBeNull();
    expect(c.byMonth.length).toBeGreaterThan(0);
    expect(c.bins.reduce((s, b) => s + b.n, 0)).toBe(c.n);

    // Cached: same object until a new book lands.
    expect(await getLearningReport()).toBe(r);
    // And served by the route.
    const body = await (await reportGET()).json();
    expect(body.selfGrade.n).toBe(c.n);
  });

  it('(c): ?demo=1 is refused (403) under NODE_ENV=production', async () => {
    const env = process.env as Record<string, string | undefined>;
    const orig = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const res = await regimeGET(new Request('http://localhost/api/accuracy/regime?demo=1'));
      expect(res.status).toBe(403);
    } finally {
      env.NODE_ENV = orig;
    }
  });
});
