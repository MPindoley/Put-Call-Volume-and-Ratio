/**
 * The coverage loader's grouped queries against a real Postgres. SKIPPED unless
 * RUN_DB_TESTS=1 (and DATABASE_URL points at a throwaway DB with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAnalyticsConfig } from './analytics-config';
import { prisma } from './db';
import { FlowEngine } from './flow-engine';
import { loadCoverageRows } from './learning-coverage';
import { regimeConfigVersion } from './regime';
import { thresholdVersion } from './signals';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const SYMBOLS = ['AAPL', 'MSFT'];
const days = [2, 3, 4, 5, 6, 9].map((d) => new Date(Date.UTC(2026, 1, d))); // six sessions, Feb 2026

async function wipe(): Promise<void> {
  await db.signalLog.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  await db.relativeMetric.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  await db.dailyMetric.deleteMany({});
}

describe.skipIf(!RUN)('loadCoverageRows (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    for (const symbol of SYMBOLS)
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Technology' }, update: {} });
    await wipe();
    // AAPL: captured every session, OI missing on one; MSFT: same close five sessions running.
    await db.dailyMetric.createMany({
      data: days.flatMap((date, i) => [
        { symbol: 'AAPL', date, close: 100 + i, iv30: 25, rrSkew: -2, putOI: i === 3 ? null : 1_000, callOI: 1_000, final: true },
        { symbol: 'MSFT', date, close: i === 0 ? 400 : 410, iv30: 22, rrSkew: -1, putOI: 1_000, callOI: 1_000, final: true },
      ]),
    });
    // A close-only backfill row is price history, not a captured session.
    await db.dailyMetric.create({
      data: { symbol: 'AAPL', date: new Date(Date.UTC(2026, 0, 30)), close: 99, final: true, historicalCloseOnly: true },
    });
    await db.relativeMetric.createMany({
      data: days.map((date) => ({ symbol: 'AAPL', date, cohort: 'XLK', final: true, skewRelSpread: 0.1 })),
    });
    const cfg = await getAnalyticsConfig();
    const stamps = {
      thresholdVersion: thresholdVersion(cfg),
      regimeConfigVersion: regimeConfigVersion({
        volDeadband: cfg.regimeVolDeadband,
        trendDeadbandPct: cfg.regimeTrendDeadbandPct,
        gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
        persistDays: cfg.regimePersistDays,
      }),
    };
    await db.signalLog.createMany({
      data: [
        { symbol: 'AAPL', firedOn: days[0]!, signalType: 'skew_z', direction: 'bullish', scored: true, ...stamps },
        { symbol: 'AAPL', firedOn: days[1]!, signalType: 'pc_extreme', direction: 'bearish', ...stamps },
        // Under old definitions: not part of what the learning uses now.
        {
          symbol: 'AAPL',
          firedOn: days[2]!,
          signalType: 'skew_z',
          direction: 'bullish',
          scored: true,
          thresholdVersion: 'old',
          regimeConfigVersion: 'old',
        },
      ],
    });
  });
  afterAll(async () => {
    if (!RUN) return;
    await wipe();
    await db.$disconnect();
  });

  it('counts each stock’s captures, options data, sector rows and current-definition signals', async () => {
    const { rows, sessions, latest } = await loadCoverageRows(db, new FlowEngine());
    expect(sessions).toBe(6);
    expect(latest).toBe('2026-02-09');
    const aapl = rows.find((r) => r.symbol === 'AAPL')!;
    expect(aapl).toMatchObject({
      captured: 6,
      firstAgo: 5,
      lastAgo: 0,
      recent: 6,
      recentWithOptions: 5,
      frozen: false,
      relRows: 6,
    });
    expect(aapl).toMatchObject({ signalsLogged: 2, signalsGraded: 1, projection: null });
    expect(aapl.stages.capture).toBe('ready');

    const msft = rows.find((r) => r.symbol === 'MSFT')!;
    expect(msft.frozen).toBe(true);
    expect(msft.stages.capture).toBe('problem');

    // A tracked stock with no rows at all, once the site has captured sessions.
    const never = rows.find((r) => r.symbol === 'NVDA')!;
    expect(never.captured).toBe(0);
    expect(never.issues.map((i) => i.text)).toContain('never captured — no session has saved its options data');
  });
});
