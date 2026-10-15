/**
 * Importing an older database into the current one, against two real Postgres
 * databases. SKIPPED unless RUN_DB_TESTS=1 and IMPORT_TEST_SOURCE_URL points at
 * a second throwaway database (schema pushed) to act as the old one.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseIdentity, importDatabase, maybeImportOldDatabase } from './db-import';
import { prisma } from './db';

const SOURCE_URL = process.env.IMPORT_TEST_SOURCE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma && !!SOURCE_URL;
const target = prisma!;
const SYM = 'ZZIMP';
const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 86_400_000);

async function wipe(db: PrismaClient): Promise<void> {
  await db.flowSnapshot.deleteMany({ where: { symbol: SYM } });
  await db.alert.deleteMany({ where: { symbol: SYM } });
  await db.dailyMetric.deleteMany({ where: { symbol: SYM } });
  await db.dailyRegime.deleteMany({ where: { date: { in: [d('2025-03-03'), d('2025-03-04'), d('2025-03-05')] } } });
  await db.edgeBook.deleteMany({ where: { version: { startsWith: 'zz-' } } });
  await db.dataImport.deleteMany({});
}

const regime = (date: string, gammaState: string | null, spxClose: number) => ({
  date: d(date),
  volState: 'pos',
  trendState: 'pos',
  gammaState,
  spxClose,
  regimeConfigVersion: 'zz',
  final: true,
});

describe.skipIf(!RUN)('importDatabase (RUN_DB_TESTS=1, IMPORT_TEST_SOURCE_URL)', () => {
  let source: PrismaClient;

  beforeAll(async () => {
    source = new PrismaClient({ datasources: { db: { url: SOURCE_URL! } } });
    for (const db of [source, target]) {
      await wipe(db);
      await db.ticker.upsert({ where: { symbol: SYM }, create: { symbol: SYM, sector: 'Unknown' }, update: {} });
    }

    // The old database: captured history up to the move, plus a provisional row on the move day.
    await source.dailyMetric.createMany({
      data: [
        { symbol: SYM, date: d('2025-03-03'), close: 100, iv30: 31, rrSkew: -4, final: true },
        { symbol: SYM, date: d('2025-03-04'), close: 101, iv30: 32, final: true },
        { symbol: SYM, date: d('2025-03-05'), iv30: 99, final: false }, // provisional on the move day
      ],
    });
    await source.dailyRegime.createMany({ data: [regime('2025-03-03', 'neg', 500), regime('2025-03-05', null, 1)] });
    await source.edgeBook.create({
      data: { asOf: d('2025-03-04'), version: 'zz-1', rowsUsed: 40, rowsUnbased: 0, nodes: {}, convictions: { [SYM]: { s: 2 } } },
    });
    await source.flowSnapshot.createMany({
      data: [
        { symbol: SYM, bucketStart: RECENT, putVolume: 10, callVolume: 20, putPremium: 0, callPremium: 0, putCallRatio: 0.5 },
        {
          symbol: SYM,
          bucketStart: d('2024-01-02'),
          putVolume: 1,
          callVolume: 1,
          putPremium: 0,
          callPremium: 0,
          putCallRatio: 1,
        },
      ],
    });

    // The new database since the move: a close-only backfill of an old day, the
    // real capture of the move day, a gammaless backfilled regime row, a regime
    // row for the move day, and an edge book built from a few days' history.
    await target.dailyMetric.createMany({
      data: [
        { symbol: SYM, date: d('2025-03-03'), close: 100, final: true, historicalCloseOnly: true },
        { symbol: SYM, date: d('2025-03-05'), close: 103, iv30: 33, final: true },
      ],
    });
    await target.dailyRegime.createMany({ data: [regime('2025-03-03', null, 500), regime('2025-03-05', 'pos', 520)] });
    await target.edgeBook.create({
      data: { asOf: d('2025-03-05'), version: 'zz-1', rowsUsed: 0, rowsUnbased: 0, nodes: {}, convictions: {} },
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    for (const db of [source, target]) await wipe(db);
    await source.$disconnect();
  });

  it('merges the old history: the current row wins, except over weaker stand-ins', async () => {
    const results = await importDatabase(source, target, { now: NOW, log: () => undefined });
    const metrics = await target.dailyMetric.findMany({ where: { symbol: SYM }, orderBy: { date: 'asc' } });
    expect(metrics.map((m) => [m.date.toISOString().slice(0, 10), m.iv30, m.historicalCloseOnly, m.final])).toEqual([
      ['2025-03-03', 31, false, true], // the captured row replaced the close-only backfill
      ['2025-03-04', 32, false, true], // copied
      ['2025-03-05', 33, false, true], // the new capture beat the old provisional row
    ]);
    expect(metrics[0]?.rrSkew).toBe(-4);
    expect(results.find((r) => r.model === 'dailyMetric')).toMatchObject({ read: 3, added: 2, replaced: 1 });

    const regimes = await target.dailyRegime.findMany({ where: { regimeConfigVersion: 'zz' }, orderBy: { date: 'asc' } });
    expect(regimes.map((r) => [r.date.toISOString().slice(0, 10), r.gammaState, r.spxClose])).toEqual([
      ['2025-03-03', 'neg', 500], // captured beat gammaless backfill
      ['2025-03-05', 'pos', 520], // the new row beat the old orphan
    ]);

    // Edge books: the new database's thin one is gone; the old one is copied.
    const books = await target.edgeBook.findMany({ where: { version: 'zz-1' } });
    expect(books.map((b) => b.asOf.toISOString().slice(0, 10))).toEqual(['2025-03-04']);

    // Snapshots: only what retention keeps.
    const snaps = await target.flowSnapshot.findMany({ where: { symbol: SYM } });
    expect(snaps.map((s) => s.bucketStart.getTime())).toEqual([RECENT.getTime()]);
  });

  it('is idempotent', async () => {
    const results = await importDatabase(source, target, { now: NOW, log: () => undefined });
    expect(results.find((r) => r.model === 'dailyMetric')).toMatchObject({ added: 0, replaced: 0 });
    expect(await target.dailyMetric.count({ where: { symbol: SYM } })).toBe(3);
  });

  it('runs once per source from IMPORT_DATABASE_URL, and waits quietly while the source is unreachable', async () => {
    const saved = process.env.IMPORT_DATABASE_URL;
    try {
      process.env.IMPORT_DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/nowhere?connect_timeout=2';
      expect(await maybeImportOldDatabase()).toBe(false);
      expect(await target.dataImport.count()).toBe(0);

      process.env.IMPORT_DATABASE_URL = SOURCE_URL;
      expect(await maybeImportOldDatabase()).toBe(true);
      expect((await target.dataImport.findMany()).map((r) => r.source)).toEqual([databaseIdentity(SOURCE_URL!)]);
      expect(await maybeImportOldDatabase()).toBe(false); // already done

      process.env.IMPORT_DATABASE_URL = process.env.DATABASE_URL;
      expect(await maybeImportOldDatabase()).toBe(false); // never imports a database into itself
    } finally {
      process.env.IMPORT_DATABASE_URL = saved;
    }
  }, 60_000);
});
