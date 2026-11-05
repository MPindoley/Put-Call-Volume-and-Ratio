/**
 * Repairing sessions whose sector z-scores were computed before their history
 * existed (a new database, history imported later), against a real Postgres.
 * SKIPPED unless RUN_DB_TESTS=1 (and DATABASE_URL points at a throwaway DB
 * with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAnalyticsConfig } from './analytics-config';
import { prisma } from './db';
import { repairThinRelativeDays } from './history-jobs';
import { findThinRelativeDays } from './sector-analytics';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const OLD = 'ZZREP'; // 20 sessions of (imported) history, then 5 thin sessions
const NEW = 'ZZNEW'; // listed on the thin sessions only: too little history to score
const VERSION = 'zz-repair';

/** 25 consecutive weekdays from 2026-03-02. */
const days: Date[] = [];
for (let t = Date.UTC(2026, 2, 2); days.length < 25; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
}
const THIN = days.slice(20);
const history = Array.from({ length: 20 }, (_, i) => 0.5 + 0.3 * Math.sin(i)); // OLD's skew spread, sessions 0–19

async function wipe(): Promise<void> {
  await db.signalLog.deleteMany({ where: { symbol: { in: [OLD, NEW] } } });
  await db.relativeMetric.deleteMany({ where: { symbol: { in: [OLD, NEW] } } });
  await db.dailyMetric.deleteMany({ where: { symbol: { in: [OLD, NEW] } } });
  await db.dailyRegime.deleteMany({ where: { date: { in: THIN } } });
}

describe.skipIf(!RUN)('repairThinRelativeDays (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    for (const symbol of [OLD, NEW]) {
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Unknown' }, update: {} });
    }
    await wipe();
    const rel = (symbol: string, date: Date, skew: number) => ({
      symbol,
      date,
      cohort: 'XLK',
      compositionVersion: VERSION,
      final: true,
      skewRelSpread: skew,
      ivRelSpread: 1,
    });
    // History (as imported): spreads only — their own z-scores do not matter here.
    await db.relativeMetric.createMany({ data: history.map((s, i) => rel(OLD, days[i]!, s)) });
    // The thin sessions, written while that history was missing: spreads, no z.
    // Session 22 is far outside OLD's usual range.
    await db.relativeMetric.createMany({
      data: THIN.flatMap((d, i) => [rel(OLD, d, i === 2 ? 5 : 0.5), rel(NEW, d, 0.4)]),
    });
    await db.dailyMetric.createMany({
      data: THIN.flatMap((date) =>
        [OLD, NEW].map((symbol) => ({ symbol, date, close: 100, final: true, historicalCloseOnly: false })),
      ),
    });
    await db.dailyRegime.createMany({
      data: THIN.map((date) => ({
        date,
        volState: 'pos',
        trendState: 'pos',
        gammaState: 'pos',
        regimeConfigVersion: 'zz',
        final: true,
      })),
    });
  });
  afterAll(async () => {
    if (!RUN) return;
    await wipe();
    await db.$disconnect();
  });

  it('finds exactly the sessions whose z-score is missing but now computable', async () => {
    const cfg = await getAnalyticsConfig();
    const found = await findThinRelativeDays(db, cfg, days[0]!);
    expect(found.map((d) => d.getTime())).toEqual(THIN.map((d) => d.getTime()));
  });

  it('fills them point-in-time, logs the signals they missed, and leaves names without history alone', async () => {
    const r = await repairThinRelativeDays();
    expect(r).toMatchObject({ days: 5, rows: 5 });

    // Session 20's z reads only sessions 0–19 (sample standard deviation).
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / (history.length - 1));
    const first = await db.relativeMetric.findUnique({ where: { symbol_date: { symbol: OLD, date: THIN[0]! } } });
    expect(first?.skewZ30).toBeCloseTo((0.5 - mean) / Math.max(sd, (await getAnalyticsConfig()).zStdevFloor), 6);

    const extreme = await db.relativeMetric.findUnique({ where: { symbol_date: { symbol: OLD, date: THIN[2]! } } });
    expect(extreme?.skewZ30).toBeGreaterThan(2);
    const sig = await db.signalLog.findUnique({
      where: { symbol_signalType_firedOn: { symbol: OLD, signalType: 'skew_z', firedOn: THIN[2]! } },
    });
    expect(sig?.direction).toBe('bullish');
    expect(r.signals).toBeGreaterThanOrEqual(1);

    // A name listed on those sessions only has nothing to score against.
    expect(await db.relativeMetric.count({ where: { symbol: NEW, skewZ30: { not: null } } })).toBe(0);
  });

  it('is done once: nothing is left to find', async () => {
    const cfg = await getAnalyticsConfig();
    expect(await findThinRelativeDays(db, cfg, days[0]!)).toEqual([]);
    expect(await repairThinRelativeDays()).toEqual({ days: 0, rows: 0, signals: 0 });
  });
});
