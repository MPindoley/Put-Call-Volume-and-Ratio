/**
 * Projection jobs against a real Postgres. SKIPPED unless RUN_DB_TESTS=1 (and
 * DATABASE_URL points at a throwaway DB with the schema pushed).
 *
 *  - weekly logging happens once per ET week, only from today's chains;
 *  - grading uses the FINALIZED close at expiry, never a provisional one;
 *  - the nightly refresh puts calibration and coverage into the engine.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { FlowEngine } from './flow-engine';
import type { ExpiryProjection, Projection } from './projection';
import { gradeProjections, logProjections, refreshProjectionHistory } from './projection-jobs';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const DAY = 86_400_000;

function weekdays(n: number, start = Date.UTC(2026, 2, 2)): Date[] {
  const out: Date[] = [];
  const d = new Date(start);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function wipe(): Promise<void> {
  await db.projectionLog.deleteMany({});
  await db.dailyMetric.deleteMany({});
  await db.ticker.createMany({
    data: [
      { symbol: 'SPY', sector: 'ETF' },
      { symbol: 'AAPL', sector: 'Technology' },
      { symbol: 'MSFT', sector: 'Technology' },
    ],
    skipDuplicates: true,
  });
}

function expiry(dte: number, q: number[]): ExpiryProjection {
  return {
    expiration: new Date(Date.UTC(2026, 9, 14) + Math.round(dte) * DAY).toISOString().slice(0, 10),
    dte,
    forward: 100,
    atmIv: 30,
    sigmaMove: 0.1,
    quantiles: q,
    grid: { price: [], probAbove: [] },
    method: 'smile',
    quotes: 20,
  };
}

describe.skipIf(!RUN)('projection jobs (RUN_DB_TESTS=1)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('logs each name once per ET week, from today’s chains only', async () => {
    const now = new Date(Date.UTC(2026, 9, 14, 21, 0)); // Wed 17:00 ET
    const engine = new FlowEngine();
    const proj = (symbol: string, dataAsOf: number): Projection => ({
      symbol,
      spot: 100,
      dataAsOf,
      method: 'p1',
      expiries: [expiry(2, [95, 98, 100, 102, 105]), expiry(9, [90, 95, 100, 105, 110]), expiry(37, [80, 90, 100, 110, 120])],
      positioning: { callWall: null, putWall: null, gammaFlip: null, gammaAtSpot: null },
    });
    engine.projections.set('AAPL', proj('AAPL', now.getTime() - 3_600_000));
    engine.projections.set('MSFT', proj('MSFT', now.getTime() - 3 * DAY)); // stale chain: skipped
    expect(await logProjections(engine, now)).toBe(2);
    const rows = await db.projectionLog.findMany({ orderBy: { horizon: 'asc' } });
    expect(rows.map((r) => [r.symbol, r.horizon, r.q16])).toEqual([
      ['AAPL', 'month', 90],
      ['AAPL', 'week', 95],
    ]);
    // Thursday of the same week: already logged.
    expect(await logProjections(engine, new Date(now.getTime() + DAY))).toBe(0);
  });

  it('grades with the finalized close at expiry, never a provisional one', async () => {
    const days = weekdays(30);
    for (let i = 0; i < 30; i++) {
      for (const symbol of ['SPY', 'AAPL']) {
        const provisional = i === 29;
        await db.dailyMetric.create({
          data: {
            symbol,
            date: days[i]!,
            close: provisional ? null : 100 + i,
            liveClose: provisional ? 100 + i : null,
            final: !provisional,
          },
        });
      }
    }
    const base = { symbol: 'AAPL', method: 'p1', spot: 100, forward: 100, q025: 80, q16: 90, q50: 100, q84: 110, q975: 120 };
    await db.projectionLog.createMany({
      data: [
        { ...base, loggedOn: days[0]!, horizon: 'week', expiration: days[5]! },
        { ...base, loggedOn: days[20]!, horizon: 'week', expiration: days[29]! }, // expiry close still provisional
      ],
    });
    expect(await gradeProjections(new Date(days[29]!.getTime() + DAY))).toBe(1);
    const graded = await db.projectionLog.findFirst({ where: { loggedOn: days[0]! } });
    expect(graded?.outcome).toBe(105);
    expect(graded?.outcomeOn?.getTime()).toBe(days[5]!.getTime());
    const waiting = await db.projectionLog.findFirst({ where: { loggedOn: days[20]! } });
    expect(waiting?.outcome).toBeNull();
  });

  it('refreshes calibration and coverage into the engine', async () => {
    const days = weekdays(80, Math.floor(Date.now() / DAY) * DAY - 140 * DAY);
    for (let i = 0; i < days.length; i++) {
      for (const [symbol, drift] of [['SPY', 0.001], ['AAPL', 0.002], ['MSFT', -0.001]] as const) {
        await db.dailyMetric.create({
          data: { symbol, date: days[i]!, close: 100 * Math.exp(drift * i + 0.01 * Math.sin(i)), iv30: 25, final: true },
        });
      }
    }
    await db.projectionLog.create({
      data: {
        symbol: 'AAPL', loggedOn: days[10]!, horizon: 'month', expiration: days[31]!, method: 'p1',
        spot: 100, forward: 100, q025: 80, q16: 90, q50: 100, q84: 110, q975: 120, outcome: 104, outcomeOn: days[31]!,
      },
    });
    const engine = new FlowEngine();
    await refreshProjectionHistory(engine);
    const aapl = engine.calibrations.get('AAPL');
    expect(aapl?.month.ticker.n).toBe(80 - 21);
    expect(aapl?.month.sector.n).toBe(2 * (80 - 21)); // AAPL + MSFT pooled as Technology
    expect(aapl?.month.ratio).toBeGreaterThan(0);
    expect(engine.projectionCoverage?.all.month.n).toBe(1);
    expect(engine.projectionCoverage?.all.month.inside68).toBe(1);
  });
});
