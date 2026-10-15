/**
 * Snapshot writes and thinning against a real Postgres (both are raw SQL, so
 * only a database can check them). SKIPPED unless RUN_DB_TESTS=1 with
 * DATABASE_URL pointing at a throwaway database whose schema has been pushed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { downsampleSnapshots, upsertFlowSnapshots, type SnapshotRow } from './history-jobs';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const SYMBOLS = ['ZZTEST1', 'ZZTEST2'];
const DAY = Date.UTC(2026, 2, 2); // Mon
const MIN = 60_000;

describe.skipIf(!RUN)('downsampleSnapshots', () => {
  beforeEach(async () => {
    await db.flowSnapshot.deleteMany({ where: { symbol: { in: SYMBOLS } } });
    for (const symbol of SYMBOLS) {
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Unknown' }, update: {} });
    }
    // Two days × 78 five-minute buckets × two symbols, cumulative volumes rising through each day.
    const rows = [];
    for (const symbol of SYMBOLS) {
      for (const day of [DAY, DAY + 86_400_000]) {
        for (let b = 0; b < 78; b++) {
          rows.push({
            symbol,
            bucketStart: new Date(day + (13 * 60 + 30) * MIN + b * 5 * MIN),
            putVolume: 100 * (b + 1),
            callVolume: 200 * (b + 1),
            putPremium: 0,
            callPremium: 0,
            putCallRatio: 0.5,
          });
        }
      }
    }
    await db.flowSnapshot.createMany({ data: rows });
  });

  afterAll(async () => {
    if (!RUN) return;
    await db.flowSnapshot.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  });

  it('keeps only the last (day-total) snapshot per symbol per day before the cutoff', async () => {
    const cutoff = new Date(DAY + 86_400_000); // thin day 1 only
    const removed = await downsampleSnapshots(db, cutoff);
    expect(removed).toBe(2 * 77);

    const day1 = await db.flowSnapshot.findMany({
      where: { symbol: { in: SYMBOLS }, bucketStart: { lt: cutoff } },
      orderBy: { symbol: 'asc' },
    });
    expect(day1).toHaveLength(2);
    // The survivor carries the day's cumulative totals.
    expect(day1.map((r) => r.putVolume + r.callVolume)).toEqual([300 * 78, 300 * 78]);

    // Day 2 (after the cutoff) is untouched.
    expect(await db.flowSnapshot.count({ where: { symbol: { in: SYMBOLS }, bucketStart: { gte: cutoff } } })).toBe(2 * 78);
  });

  it('is idempotent', async () => {
    const cutoff = new Date(DAY + 86_400_000);
    await downsampleSnapshots(db, cutoff);
    expect(await downsampleSnapshots(db, cutoff)).toBe(0);
  });
});

describe.skipIf(!RUN)('upsertFlowSnapshots', () => {
  const B1 = new Date(DAY + 14 * 60 * MIN); // 14:00 UTC
  const B2 = new Date(DAY + 14 * 60 * MIN + 5 * MIN);
  const row = (symbol: string, bucketStart: Date, put: number, extra: Partial<SnapshotRow> = {}): SnapshotRow => ({
    symbol,
    bucketStart,
    putVolume: put,
    callVolume: put * 2,
    putPremium: put * 10,
    callPremium: put * 20,
    putCallRatio: 0.5,
    spikeScore: 1,
    underlying: 101.25,
    ...extra,
  });

  beforeEach(async () => {
    await db.flowSnapshot.deleteMany({ where: { symbol: { in: SYMBOLS } } });
    for (const symbol of SYMBOLS) {
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Unknown' }, update: {} });
    }
  });

  afterAll(async () => {
    if (!RUN) return;
    await db.flowSnapshot.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  });

  it('inserts a cycle in one statement, with exact UTC bucket times whatever the session time zone', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
      await upsertFlowSnapshots(tx, [row('ZZTEST1', B1, 100), row('ZZTEST2', B1, 300, { underlying: null, putCallRatio: 1 })]);
    });
    const rows = await db.flowSnapshot.findMany({ where: { symbol: { in: SYMBOLS } }, orderBy: { symbol: 'asc' } });
    expect(rows.map((r) => r.bucketStart.getTime())).toEqual([B1.getTime(), B1.getTime()]);
    expect(rows[0]).toMatchObject({
      putVolume: 100,
      callVolume: 200,
      putPremium: 1_000,
      callPremium: 2_000,
      spikeScore: 1,
      underlying: 101.25,
    });
    expect(rows[1]).toMatchObject({ putVolume: 300, putCallRatio: 1, underlying: null });
  });

  it('updates volumes, ratio and spike in a filled bucket and keeps its first premiums and underlying', async () => {
    await upsertFlowSnapshots(db, [row('ZZTEST1', B1, 100)]);
    await upsertFlowSnapshots(db, [
      row('ZZTEST1', B1, 150, { putCallRatio: 0.7, spikeScore: 3, underlying: 99 }),
      row('ZZTEST1', B2, 160),
    ]);
    const [first, second] = await db.flowSnapshot.findMany({ where: { symbol: 'ZZTEST1' }, orderBy: { bucketStart: 'asc' } });
    expect(first).toMatchObject({
      putVolume: 150,
      callVolume: 300,
      putCallRatio: 0.7,
      spikeScore: 3,
      putPremium: 1_000,
      underlying: 101.25,
    });
    expect(second).toMatchObject({ putVolume: 160 });
  });

  it('takes the last of two rows for one bucket, and writes nothing for an empty cycle', async () => {
    await upsertFlowSnapshots(db, [row('ZZTEST1', B1, 100), row('ZZTEST1', B1, 120)]);
    const rows = await db.flowSnapshot.findMany({ where: { symbol: 'ZZTEST1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.putVolume).toBe(120);
    expect(await upsertFlowSnapshots(db, [])).toBe(0);
  });
});
