/**
 * Restart safety against a real Postgres. SKIPPED unless RUN_DB_TESTS=1 (and
 * DATABASE_URL points at a throwaway DB with the schema pushed).
 *
 * The scenario that motivated it: a deploy restarts the server just after the
 * close, so the end-of-day capture finds an empty table.
 *  - the capture refuses to pin a partial day (nothing written);
 *  - after the catch-up refills the table, a late capture pins it;
 *  - a regime row written before the day was captured is rebuilt once;
 *  - the saved table survives a restart through the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainAnalytics } from '@/types';
import { prisma } from './db';
import { restoreEngineSnapshot, saveEngineSnapshot } from './engine-snapshot';
import { FlowEngine } from './flow-engine';
import { maybeCaptureEndOfDay } from './history-jobs';
import type { OptionsChainAggregate } from './provider';
import { recordDailyRegime } from './regime-jobs';
import { TRACKED_UNIVERSE } from './universe';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;

// Wednesday 2026-10-14: in the capture window (16:25 ET) and after it (18:00 ET).
const IN_WINDOW = new Date('2026-10-14T20:25:00Z');
const AFTER_WINDOW = new Date('2026-10-14T22:00:00Z');
const TODAY = new Date(Date.UTC(2026, 9, 14));
const CLOSE_ASOF = Date.UTC(2026, 9, 14, 20, 0);

function analytics(gex: number): ChainAnalytics {
  return {
    rrSkew25: -3,
    atmIvNear: 25,
    atmIvFar: 26,
    termSlope: 1,
    backwardated: false,
    eventExpiry: null,
    impliedMovePct: 3,
    putOI: 10_000,
    callOI: 12_000,
    oiPutCall: 0.83,
    maxPain: 100,
    topStrikes: [],
    gexPer1Pct: gex,
    leapIv: 27,
  };
}

function closeSnap(symbol: string): OptionsChainAggregate {
  return {
    symbol,
    putVolume: 1_000,
    callVolume: 1_500,
    putPremium: 50_000,
    callPremium: 75_000,
    underlyingPrice: symbol === 'SPY' ? 650 : 100,
    priceChangePct: 0.4,
    contractsSeen: 20,
    largestContractVolume: 100,
    iv30: 25,
    iv30Change: 0.1,
    analytics: analytics(1_000_000),
    asOf: CLOSE_ASOF,
  };
}

async function wipe(): Promise<void> {
  await db.signalLog.deleteMany({});
  await db.relativeMetric.deleteMany({});
  await db.cohortDaily.deleteMany({});
  await db.dailyRegime.deleteMany({});
  await db.dailyMetric.deleteMany({});
  await db.projectionLog.deleteMany({});
  await db.engineSnapshot.deleteMany({});
}

describe.skipIf(!RUN)('restart safety (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    await db.ticker.createMany({ data: TRACKED_UNIVERSE.map(({ symbol, sector }) => ({ symbol, sector })), skipDuplicates: true });
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('refuses to pin a day from an empty table, then pins it late once the catch-up refilled it', async () => {
    const empty = new FlowEngine();
    empty.mode = 'live';
    expect(await maybeCaptureEndOfDay(empty, { now: IN_WINDOW })).toBe(false);
    expect(await db.dailyMetric.count({ where: { date: TODAY, final: true } })).toBe(0);
    expect(await db.cohortDaily.count({ where: { date: TODAY } })).toBe(0);

    // Simulate the old failure: a regime row written before the day was captured.
    await recordDailyRegime(empty, IN_WINDOW);
    const orphan = await db.dailyRegime.findUnique({ where: { date: TODAY } });
    expect(orphan?.final).toBe(true);
    expect(orphan?.aggGex).toBeNull();

    // The catch-up pass refills the table with the session's closing data.
    const engine = new FlowEngine();
    engine.mode = 'live';
    const symbols = ['SPY', ...TRACKED_UNIVERSE.map((u) => u.symbol).filter((s) => s !== 'SPY')].slice(
      0,
      Math.ceil(TRACKED_UNIVERSE.length * 0.5) + 5,
    );
    for (const s of symbols) engine.ingest(closeSnap(s), AFTER_WINDOW.getTime());

    // Outside the regular window, only a late (post-catch-up) capture runs.
    expect(await maybeCaptureEndOfDay(engine, { now: AFTER_WINDOW })).toBe(false);
    expect(await maybeCaptureEndOfDay(engine, { now: AFTER_WINDOW, late: true })).toBe(true);
    expect(await db.dailyMetric.count({ where: { date: TODAY, final: true, historicalCloseOnly: false } })).toBe(symbols.length);

    // The orphan regime row was rebuilt from the real inputs, once.
    const rebuilt = await db.dailyRegime.findUnique({ where: { date: TODAY } });
    expect(rebuilt?.aggGex).not.toBeNull();
    expect(rebuilt?.spxClose).toBe(650);
    expect(await recordDailyRegime(engine, AFTER_WINDOW)).toBe(false);

    // Already pinned: a second late capture is a no-op.
    expect(await maybeCaptureEndOfDay(engine, { now: AFTER_WINDOW, late: true })).toBe(false);
  }, 120_000);

  it('saves the table and restores it into a new process', async () => {
    const engine = new FlowEngine();
    engine.mode = 'live';
    for (const s of ['SPY', 'AAPL', 'MSFT']) engine.ingest(closeSnap(s), AFTER_WINDOW.getTime());
    engine.finalizeCycle(AFTER_WINDOW.getTime());
    expect(await saveEngineSnapshot(engine, 'test')).toBe(true);

    const next = new FlowEngine();
    next.mode = 'live';
    expect(await restoreEngineSnapshot(next)).toBe(3);
    expect(next.getFlow('AAPL')?.dataAsOf).toBe(CLOSE_ASOF);
    expect(next.getFlow('AAPL')?.analytics?.gexPer1Pct).toBe(1_000_000);

    // Simulated data is never saved over a live table, nor restored into one.
    const sim = new FlowEngine();
    sim.mode = 'simulated';
    sim.ingest(closeSnap('AAPL'), AFTER_WINDOW.getTime());
    expect(await saveEngineSnapshot(sim, 'test')).toBe(false);
    expect(await restoreEngineSnapshot(sim)).toBe(0);
    // An empty table never overwrites a good save.
    const blank = new FlowEngine();
    blank.mode = 'live';
    expect(await saveEngineSnapshot(blank, 'test')).toBe(false);
    expect((await db.engineSnapshot.findUnique({ where: { id: 1 } }))?.rows).toBe(3);
  });
});
