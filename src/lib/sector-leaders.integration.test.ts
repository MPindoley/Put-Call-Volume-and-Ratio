/**
 * The who-leads-whom loader against a real Postgres. SKIPPED unless
 * RUN_DB_TESTS=1 (and DATABASE_URL points at a throwaway DB with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { loadSectorLeaders } from './sector-leader-jobs';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const N = 70;
const SYMBOLS = ['SPY', 'XLK', 'AAPL', 'MSFT'];

/** N consecutive weekdays ending recently. */
const days: Date[] = [];
for (let t = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 110 * 86_400_000; days.length < N; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
}

describe.skipIf(!RUN)('sector leaders (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    await db.dailyMetric.deleteMany({});
    for (const symbol of SYMBOLS) {
      await db.ticker.upsert({
        where: { symbol },
        create: { symbol, sector: symbol.length === 3 ? 'ETF' : 'Technology' },
        update: {},
      });
    }
    // XLK's move tomorrow is written into AAPL's skew change today; MSFT's skew wanders on its own.
    const move = days.map((_, i) => 0.01 * Math.sin(i * 2.1) + 0.004 * Math.cos(i * 0.7));
    const rows = [];
    let xlk = 200;
    let aapl = 0;
    let msft = 0;
    for (let i = 0; i < N; i++) {
      rows.push({ symbol: 'SPY', date: days[i]!, close: 500, final: true });
      rows.push({ symbol: 'XLK', date: days[i]!, close: xlk, final: true });
      aapl += (move[i] ?? 0) * 50;
      msft += Math.sin(i * 5.3);
      rows.push({ symbol: 'AAPL', date: days[i]!, close: 100, rrSkew: aapl, final: true });
      rows.push({ symbol: 'MSFT', date: days[i]!, close: 100, rrSkew: msft, final: true });
      xlk *= Math.exp(move[i] ?? 0);
    }
    await db.dailyMetric.createMany({ data: rows });
  });
  afterAll(async () => {
    if (!RUN) return;
    await db.dailyMetric.deleteMany({ where: { symbol: { in: SYMBOLS } } });
    await db.$disconnect();
  });

  it('ranks a cohort’s members from stored skew and closes, and lists the cohorts', async () => {
    const r = (await loadSectorLeaders('XLK'))!;
    expect(r.cohort).toBe('XLK');
    expect(r.cohorts.some((c) => c.cohort === 'XLK')).toBe(true);
    expect(r.asOf).toBe(days[N - 1]!.toISOString().slice(0, 10));
    expect(r.tested).toBe(2);
    expect(r.leaders.map((x) => x.symbol)).toEqual(['AAPL']);
    expect(r.leaders[0]!.rho).toBeGreaterThan(0.9);
    expect(r.leaders[0]!.n).toBe(N - 2); // no change on the first session, no next close on the last
    // An unknown cohort falls back to the first one rather than failing.
    expect((await loadSectorLeaders('NOPE'))!.cohorts.length).toBe(r.cohorts.length);
  });
});
