/**
 * Signal timing against a real Postgres: the nightly job rebuilds the latest
 * edge book at the 5-, 10- and 20-session windows from one load, stores them
 * once per session, and the API and the ticker's track record read them.
 * SKIPPED unless RUN_DB_TESTS=1 (and DATABASE_URL points at a throwaway DB
 * with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as learningGET } from '@/app/api/learning/route';
import { getAnalyticsConfig } from './analytics-config';
import { prisma } from './db';
import { loadTimingBooks, loadTrackRecord } from './learning-data';
import { refreshEdgeBooks } from './learning-jobs';
import { regimeConfigVersion } from './regime';
import type { ComboView } from './signal-combos';
import { timingAt } from './signal-timing';
import { thresholdVersion } from './signals';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const N = 60;

/** 60 consecutive weekdays from 2026-03-02. */
const days: Date[] = [];
for (let t = Date.UTC(2026, 2, 2); days.length < N; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
}

async function wipe(): Promise<void> {
  await db.signalTiming.deleteMany({});
  await db.edgeBook.deleteMany({});
  await db.signalLog.deleteMany({});
  await db.dailyMetric.deleteMany({});
  await db.dailyRegime.deleteMany({});
}

describe.skipIf(!RUN)('signal timing (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    await wipe();
    await db.ticker.createMany({
      data: [
        { symbol: 'SPY', sector: 'ETF' },
        { symbol: 'XLK', sector: 'ETF' },
        { symbol: 'AAPL', sector: 'Technology' },
        { symbol: 'MSFT', sector: 'Technology' },
      ],
      skipDuplicates: true,
    });
    const cfg = await getAnalyticsConfig();
    const tv = thresholdVersion(cfg);
    const rv = regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    });
    const metrics = [];
    for (let i = 0; i < N; i++) {
      const row = (symbol: string, close: number, oi: boolean) => ({
        symbol,
        date: days[i]!,
        close,
        final: true,
        historicalCloseOnly: false,
        ...(oi ? { putOI: 1000, callOI: 1000, spikeBaselineDays: 20 } : {}),
      });
      metrics.push(row('SPY', 500, false)); // flat market → excess = raw
      metrics.push(row('XLK', 200, false));
      // Oscillating names: forward returns change sign at every window → base ≈ 50%.
      metrics.push(row('AAPL', 100 + 5 * Math.sin(i / 3), true));
      metrics.push(row('MSFT', 100 + 5 * Math.cos(i / 3), true));
    }
    await db.dailyMetric.createMany({ data: metrics });
    await db.dailyRegime.createMany({
      data: days.map((date) => ({
        date,
        volState: 'pos',
        trendState: 'pos',
        gammaState: 'pos',
        regimeConfigVersion: rv,
        final: true,
      })),
    });
    // 40 graded bullish signals per name: right 4 times in 5 after 5 sessions,
    // 3 in 5 after 10, and a coin flip after 20 — a signal that works fast and fades.
    const stamp = {
      signalType: 'pc_extreme',
      direction: 'bullish',
      thresholdVersion: tv,
      regimeConfigVersion: rv,
      regimeVol: 'pos',
      regimeTrend: 'pos',
      regimeGamma: 'pos',
    };
    // After 10 sessions: 4 in 5 right on the days a second signal agreed, a coin flip on the others.
    const ret10 = (i: number): number => ((i % 2 === 0 ? i % 10 !== 0 : i % 4 === 1) ? 0.02 : -0.02);
    const sigs: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      for (const symbol of ['AAPL', 'MSFT']) {
        sigs.push({
          ...stamp,
          symbol,
          firedOn: days[i]!,
          scored: true,
          fwd5ExSpy: i % 5 !== 0 ? 0.02 : -0.02,
          fwd10ExSpy: ret10(i),
          fwd20ExSpy: i % 2 === 0 ? 0.02 : -0.02,
        });
        // On even sessions a volume spike fired the same way too: those days go better.
        if (i % 2 === 0)
          sigs.push({ ...stamp, signalType: 'spike_alert', symbol, firedOn: days[i]!, scored: true, fwd10ExSpy: ret10(i) });
      }
    }
    // Tonight's signal on AAPL: fired on the latest session, not graded yet.
    sigs.push({ ...stamp, symbol: 'AAPL', firedOn: days[N - 1]!, scored: false });
    await db.signalLog.createMany({ data: sigs as never });
  });
  afterAll(async () => {
    if (!RUN) return;
    await wipe();
    await db.$disconnect();
  });

  it('stores the latest book at all three windows, once per session', async () => {
    const res = await refreshEdgeBooks();
    expect(res?.written).toBeGreaterThan(0);
    const rows = await db.signalTiming.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asOf.toISOString().slice(0, 10)).toBe(days[N - 1]!.toISOString().slice(0, 10));
    expect(Object.keys(rows[0]!.books as object).sort()).toEqual(['10', '20', '5']);
    // The 10-session window is the canonical edge book, node for node.
    const canonical = (await db.edgeBook.findFirst({ where: { version: rows[0]!.version }, orderBy: { asOf: 'desc' } }))!;
    const node = 'signal:pc_extreme|bullish';
    const stored = (rows[0]!.books as Record<string, Record<string, { n: number; excess: number }>>)['10']![node]!;
    const book = (canonical.nodes as Record<string, { n: number; excess: number }>)[node]!;
    expect(stored.n).toBe(book.n);
    expect(stored.excess).toBeCloseTo(book.excess, 3);

    const before = rows[0]!.updatedAt.getTime();
    await refreshEdgeBooks(); // same session: nothing to rebuild
    expect((await db.signalTiming.findMany())[0]!.updatedAt.getTime()).toBe(before);
  });

  it('reads the timing off the three books: strongest early, gone by four weeks', async () => {
    const timing = (await loadTimingBooks(db))!;
    const t = timingAt(
      timing.books,
      { signalType: 'pc_extreme', direction: 'bullish', regime: '', sector: '', symbol: '' },
      'signal',
    );
    expect(t.graded).toBe(80);
    const [w5, w10, w20] = t.windows.map((w) => w.edge) as [number, number, number];
    expect(w5).toBeGreaterThan(w10);
    expect(w10).toBeGreaterThan(w20);
    expect(Math.abs(w20)).toBeLessThan(0.05);
    expect(t).toMatchObject({ verdict: 'fast', best: 5 });
  });

  it('serves it on the learning API and on the stock’s track record', async () => {
    const body = (await (await learningGET()).json()) as {
      timing: {
        asOf: string;
        signals: Record<string, { all: { verdict: string }; regimes: Record<string, { verdict: string }> }>;
      } | null;
    };
    expect(body.timing?.signals['pc_extreme|bullish']?.all.verdict).toBe('fast');
    expect(body.timing?.signals['pc_extreme|bullish']?.regimes['pos|pos']?.verdict).toBe('fast');

    // Signals together: the put/call signal with a volume spike agreeing, against the put/call signal alone.
    const combos = ((await (await learningGET()).json()) as { combos: { pairs: ComboView[] } | null }).combos!;
    const pair = combos.pairs.find((c) => c.a === 'pc_extreme' && c.b === 'spike_alert' && c.direction === 'bullish')!;
    expect(pair).toMatchObject({ n: 40, nA: 40, nB: 0, verdict: 'stronger' });
    expect(pair.together!).toBeGreaterThan(pair.aAlone + 0.05);
    expect(pair.bAlone).toBe(0); // the spike never fired without the put/call signal here

    const record = await loadTrackRecord(db, 'AAPL');
    expect(record.learned).toHaveLength(1);
    // AAPL has 40 graded signals of its own: enough for its timing to be read at the stock level.
    expect(record.learned[0]!.timing).toMatchObject({ level: 'ticker', verdict: 'fast', best: 5, graded: 40 });
  });
});
