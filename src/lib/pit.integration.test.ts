/**
 * Point-in-time integration harness (review proposal 1). Runs against a throwaway
 * Postgres; SKIPPED unless RUN_DB_TESTS=1 (and DATABASE_URL points at that DB), so
 * the default pure suite is unaffected. Push the schema first: `prisma db push`.
 *
 * Four assertions the pure suite structurally cannot make:
 *   (a) a provisional row is never used as a scored signal's forward endpoint;
 *   (b) a seeded row never reaches the regime matrix;
 *   (c) ?demo=1 returns 403 under NODE_ENV=production (seed-guard on the route);
 *   (d) a scored SignalLog row's forward endpoint is always a FINALIZED close.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { scoreSignals } from './signal-jobs';
import { buildRegimeMatrixData } from './matrix-data';
import { thresholdVersion } from './signals';
import { regimeConfigVersion } from './regime';
import { getAnalyticsConfig } from './analytics-config';
import { GET as regimeGET } from '@/app/api/accuracy/regime/route';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;

// 25 consecutive weekday sessions (Mon 2026-03-02 …); weekends skipped.
function weekdays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date(Date.UTC(2026, 2, 2));
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function wipe(): Promise<void> {
  await db.signalLog.deleteMany({});
  await db.dailyMetric.deleteMany({});
  await db.dailyRegime.deleteMany({});
  // DailyMetric.symbol FKs to Ticker — ensure the fixtures' tickers exist.
  await db.ticker.createMany({
    data: [
      { symbol: 'SPY', sector: 'ETF' },
      { symbol: 'AAPL', sector: 'Technology' },
    ],
    skipDuplicates: true,
  });
}

describe.skipIf(!RUN)('PIT integration (RUN_DB_TESTS=1)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('(a)+(d): a provisional endpoint is never scored; the finalized close is used once it lands', async () => {
    const cfg = await getAnalyticsConfig();
    const tv = thresholdVersion(cfg);
    const rv = regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    });
    const days = weekdays(25);
    // SPY + AAPL finalized closes for D0..D19; D20 starts PROVISIONAL (close null, liveClose set).
    for (let i = 0; i < 21; i++) {
      const provisional = i === 20;
      for (const [symbol, base] of [['SPY', 500], ['AAPL', 100]] as const) {
        const px = base + i; // strictly increasing so the sign is deterministic
        await db.dailyMetric.create({
          data: {
            symbol,
            date: days[i]!,
            close: provisional ? null : px,
            liveClose: provisional ? px : null,
            final: !provisional,
            historicalCloseOnly: false,
          },
        });
      }
    }
    const signal = await db.signalLog.create({
      data: {
        symbol: 'AAPL',
        firedOn: days[0]!,
        signalType: 'skew_z',
        direction: 'bullish',
        thresholdVersion: tv,
        regimeConfigVersion: rv,
        regimeVol: 'pos',
        regimeTrend: 'pos',
        regimeGamma: 'pos',
      },
    });

    // Endpoint D20 is provisional → the 20-td window is NOT scoreable yet.
    await scoreSignals();
    let row = await db.signalLog.findUniqueOrThrow({ where: { id: signal.id } });
    expect(row.scored).toBe(false);
    expect(row.fwd20Raw).toBeNull();

    // Finalize D20 with the OFFICIAL close, distinct from the provisional liveClose.
    for (const [symbol, base] of [['SPY', 500], ['AAPL', 100]] as const) {
      await db.dailyMetric.update({
        where: { symbol_date: { symbol, date: days[20]! } },
        data: { close: base + 20, final: true },
      });
    }
    await scoreSignals();
    row = await db.signalLog.findUniqueOrThrow({ where: { id: signal.id } });
    expect(row.scored).toBe(true);
    // fwd20Raw must equal ln(finalizedClose20 / close0) = ln(120/100).
    expect(row.fwd20Raw).toBeCloseTo(Math.log(120 / 100), 10);
  });

  it('(b): seeded rows never reach the matrix', async () => {
    const cfg = await getAnalyticsConfig();
    const tv = thresholdVersion(cfg);
    const rv = regimeConfigVersion({
      volDeadband: cfg.regimeVolDeadband,
      trendDeadbandPct: cfg.regimeTrendDeadbandPct,
      gammaDeadbandFrac: cfg.regimeGammaDeadbandFrac,
      persistDays: cfg.regimePersistDays,
    });
    const days = weekdays(3);
    await db.dailyRegime.create({
      data: { date: days[0]!, volState: 'pos', trendState: 'pos', gammaState: 'pos', regimeConfigVersion: rv, final: true, seeded: true },
    });
    // 30 SEEDED, already-scored directional signals that would otherwise form a cell.
    for (let i = 0; i < 30; i++) {
      await db.signalLog.create({
        data: {
          seeded: true,
          symbol: 'AAPL',
          firedOn: new Date(Date.UTC(2026, 2, 2, 0, 0, i)), // distinct keys
          signalType: 'skew_z',
          direction: 'bullish',
          thresholdVersion: tv,
          regimeConfigVersion: rv,
          regimeVol: 'pos',
          regimeTrend: 'pos',
          regimeGamma: 'pos',
          scored: true,
          fwd10ExSpy: 0.02,
        },
      });
    }
    const data = await buildRegimeMatrixData(10, 'exSpy');
    expect(data).not.toBeNull();
    // Seeded rows are invisible → still warming, no cells.
    expect(data!.warming).toBe(true);
    expect(data!.matrix).toBeNull();
    expect(data!.signalsScored).toBe(0);
  });

  it('(c): ?demo=1 is refused (403) under NODE_ENV=production', async () => {
    const env = process.env as Record<string, string | undefined>;
    const orig = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const res = await regimeGET(new Request('http://localhost/api/accuracy/regime?demo=1'));
      expect(res.status).toBe(403);
    } finally {
      env.NODE_ENV = orig;
    }
  });
});
