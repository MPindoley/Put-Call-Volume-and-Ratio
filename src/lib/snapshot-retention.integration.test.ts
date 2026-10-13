/**
 * Snapshot thinning against a real Postgres (the DELETE … USING is raw SQL, so
 * only a database can check it). SKIPPED unless RUN_DB_TESTS=1 with DATABASE_URL
 * pointing at a throwaway database whose schema has been pushed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { downsampleSnapshots } from './history-jobs';

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
