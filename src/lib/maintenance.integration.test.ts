/**
 * The maintenance pass against a real Postgres. SKIPPED unless RUN_DB_TESTS=1
 * (and DATABASE_URL points at a throwaway DB with the schema pushed).
 *  - the whole-table daily jobs run once, then skip until finalized data changes;
 *  - baselines keep one row per symbol, not one per pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { FlowEngine } from './flow-engine';
import { runMaintenance } from './history-jobs';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const SYMBOL = 'ZZMAINT';
const DAY_MS = 86_400_000;

async function wipe(): Promise<void> {
  await db.flowSnapshot.deleteMany({ where: { symbol: SYMBOL } });
  await db.volumeBaseline.deleteMany({ where: { symbol: SYMBOL } });
  await db.dailyMetric.deleteMany({ where: { symbol: SYMBOL } });
}

async function latestBaseline(): Promise<{ count: number; computedAt: number }> {
  const rows = await db.volumeBaseline.findMany({ where: { symbol: SYMBOL }, orderBy: { computedAt: 'desc' } });
  return { count: rows.length, computedAt: rows[0]?.computedAt.getTime() ?? 0 };
}

describe.skipIf(!RUN)('runMaintenance (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    // No live feed: the close/HV backfills would otherwise call CBOE.
    (globalThis as { __dataProvider?: null }).__dataProvider = null;
    await db.ticker.upsert({ where: { symbol: SYMBOL }, create: { symbol: SYMBOL, sector: 'Unknown' }, update: {} });
    await wipe();
    // Four past days of closing snapshots: enough for a baseline.
    const start = Date.now() - 6 * DAY_MS;
    await db.flowSnapshot.createMany({
      data: [0, 1, 2, 3].map((d) => ({
        symbol: SYMBOL,
        bucketStart: new Date(start + d * DAY_MS),
        putVolume: 1_000 + d * 100,
        callVolume: 2_000,
        putPremium: 0,
        callPremium: 0,
        putCallRatio: 0.5,
      })),
    });
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('runs the daily jobs once, skips them while nothing changed, and reruns on new finalized data', async () => {
    const engine = new FlowEngine();
    await runMaintenance(engine);
    const first = await latestBaseline();
    expect(first.count).toBe(1);

    await new Promise((r) => setTimeout(r, 20));
    await runMaintenance(engine);
    expect(await latestBaseline()).toEqual(first); // skipped: same inputs

    // The end-of-day capture (or a backfill) adds finalized rows.
    await db.dailyMetric.create({
      data: { symbol: SYMBOL, date: new Date(Date.UTC(2026, 0, 2)), close: 10, final: true, historicalCloseOnly: true },
    });
    await runMaintenance(engine);
    const third = await latestBaseline();
    expect(third.computedAt).toBeGreaterThan(first.computedAt);
    expect(third.count).toBe(1); // the superseded row is gone
  }, 60_000);
});
