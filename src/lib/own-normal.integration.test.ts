/**
 * Each name's own normal against a real Postgres: the percentile is filled
 * point-in-time in one statement, past sessions get the pc_own signals they
 * would have fired, and the usual range reaches the engine's rows.
 * SKIPPED unless RUN_DB_TESTS=1 (and DATABASE_URL points at a throwaway DB
 * with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { FlowEngine } from './flow-engine';
import { OWN_NORMAL, ownPercentile } from './own-normal';
import { fillOwnPutCall, loadOwnRangesIntoEngine, repairOwnPutCall } from './own-normal-jobs';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const HEDGED = 'ZZHEDG'; // always put-heavy (≈1.5): the fixed band would flag it daily
const YOUNG = 'ZZYOUNG'; // listed for 30 sessions: no normal yet
const N = 50;

/** N consecutive weekdays ending a few days ago (inside the jobs' look-back). */
const days: Date[] = [];
for (let t = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 80 * 86_400_000; days.length < N; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
}
/** HEDGED's put/call by session: 1.40–1.60 in a slow wave, then a jump to 1.90 on the last session. */
const pc = (i: number): number => (i === N - 1 ? 1.9 : 1.5 + 0.1 * Math.sin(i / 4));

async function wipe(): Promise<void> {
  await db.signalLog.deleteMany({ where: { symbol: { in: [HEDGED, YOUNG] } } });
  await db.dailyMetric.deleteMany({ where: { symbol: { in: [HEDGED, YOUNG] } } });
  await db.dailyRegime.deleteMany({ where: { date: { in: days } } });
}

describe.skipIf(!RUN)('own normal (RUN_DB_TESTS=1)', () => {
  beforeAll(async () => {
    for (const symbol of [HEDGED, YOUNG])
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Unknown' }, update: {} });
    await wipe();
    await db.dailyMetric.createMany({
      data: [
        ...days.map((date, i) => ({
          symbol: HEDGED,
          date,
          close: 100,
          putOI: Math.round(pc(i) * 10_000),
          callOI: 10_000,
          final: true,
        })),
        ...days.slice(-30).map((date) => ({ symbol: YOUNG, date, close: 50, putOI: 5_000, callOI: 10_000, final: true })),
        // Not a pinned session with open interest: never ranked, never ranked against.
        { symbol: YOUNG, date: new Date(days[0]!.getTime() - 86_400_000 * 7), close: 50, final: true, historicalCloseOnly: true },
      ],
    });
    await db.dailyRegime.createMany({
      data: days.map((date) => ({
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

  it('ranks each session against the name’s previous sessions only, and leaves a name without a normal alone', async () => {
    const extremeDays = await fillOwnPutCall(db, days[0]!);
    const rows = await db.dailyMetric.findMany({ where: { symbol: HEDGED }, orderBy: { date: 'asc' } });
    // The first 40 sessions have fewer than 40 behind them.
    expect(rows.slice(0, OWN_NORMAL.minObs).every((r) => r.oiPcPct === null)).toBe(true);
    expect(rows.slice(OWN_NORMAL.minObs).every((r) => r.oiPcPct !== null)).toBe(true);
    // Same number as the definition gives from the sessions before it.
    const at = 45;
    const prior = Array.from({ length: at }, (_, i) => Math.round(pc(i) * 10_000) / 10_000);
    expect(rows[at]!.oiPcPct).toBeCloseTo(ownPercentile(prior, Math.round(pc(at) * 10_000) / 10_000)!, 9);
    // Its jump to 1.90 is beyond anything it has done; an ordinary 1.5 day is not.
    expect(rows[N - 1]!.oiPcPct).toBe(1);
    expect(extremeDays.map((d) => d.getTime())).toContain(days[N - 1]!.getTime());
    expect(await db.dailyMetric.count({ where: { symbol: YOUNG, oiPcPct: { not: null } } })).toBe(0);
    // Nothing left to fill: a second pass changes nothing.
    expect(await fillOwnPutCall(db, days[0]!)).toEqual([]);
  });

  it('logs the signals past sessions would have fired, once', async () => {
    await db.dailyMetric.updateMany({ where: { symbol: HEDGED }, data: { oiPcPct: null } });
    const r = await repairOwnPutCall();
    expect(r.days).toBeGreaterThanOrEqual(1);
    const own = await db.signalLog.findMany({ where: { symbol: HEDGED, signalType: 'pc_own' }, orderBy: { firedOn: 'asc' } });
    const last = own[own.length - 1]!;
    expect(last.firedOn.getTime()).toBe(days[N - 1]!.getTime());
    expect(last).toMatchObject({ direction: 'bearish', magnitude: 1, detail: OWN_NORMAL.version });
    // All ten of its ranked sessions sit above the fixed 1.3 band; against its own range only a few stand out.
    const ranked = await db.dailyMetric.findMany({ where: { symbol: HEDGED, oiPcPct: { not: null } } });
    expect(ranked).toHaveLength(N - OWN_NORMAL.minObs);
    expect(ranked.every((r) => r.putOI! / r.callOI! >= 1.3)).toBe(true);
    expect(own.length).toBeLessThanOrEqual(4);
    expect(await repairOwnPutCall()).toEqual({ days: 0, signals: 0 });
  });

  it('gives the engine each name’s usual range, for names that have one', async () => {
    const engine = new FlowEngine();
    expect(await loadOwnRangesIntoEngine(engine)).toBeGreaterThanOrEqual(1);
    const range = engine.ownPc.get(HEDGED)!;
    expect(range.n).toBe(N);
    expect(range.lo).toBeGreaterThan(1.39);
    expect(range.mid).toBeCloseTo(1.5, 1);
    expect(range.hi).toBeLessThan(1.7);
    expect(engine.ownPc.has(YOUNG)).toBe(false);
  });
});
