/**
 * Time-of-day learning against a real Postgres: folding sessions into the
 * daily clocks (once each), loading them into the spike detector, and grading
 * spike alerts from stored prices. SKIPPED unless RUN_DB_TESTS=1 (and
 * DATABASE_URL points at a throwaway DB with the schema pushed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { FlowEngine } from './flow-engine';
import { foldIntradayProfiles, loadClockReport, loadClocksIntoEngine } from './intraday-jobs';
import { BUCKETS, DEFAULT_INTRADAY_SHAPE } from './intraday-profile';
import { gradeSpikeAlerts, loadSpikeBookIntoEngine, loadSpikeReport, loadSpikeSummary } from './spike-outcome-jobs';
import { sessionBounds } from './trading-calendar';

const RUN = process.env.RUN_DB_TESTS === '1' && !!prisma;
const db = prisma!;
const MIN = 60_000;
const SYMBOLS = ['AAPL', 'MSFT', 'SPY'];
// Wed, Thu, Fri (the week's last session), Mon — and "now" is Monday evening.
const WED = '2026-03-11';
const THU = '2026-03-12';
const FRI = '2026-03-13';
const MON = '2026-03-16';
const NOW = new Date(sessionBounds(MON)!.closeMs + 120 * MIN);
const at = (session: string, minutes: number): Date => new Date(sessionBounds(session)!.openMs + minutes * MIN);
const utc = (session: string): Date => new Date(`${session}T00:00:00Z`);

const FRONT = [400, 100, ...new Array<number>(11).fill(50)]; // 1,050 contracts, 38% in the first half hour
const BACK = [...new Array<number>(11).fill(50), 100, 400];

/**
 * 5-minute snapshots of a session with the given half-hour volumes (40% puts);
 * price drifts `perMin` a minute. A row describes the middle of its bucket,
 * which is how the jobs date it.
 */
function snapshots(symbol: string, session: string, perBucket: number[], price: number, perMin: number, until = 390) {
  const rows = [];
  for (let start = 0; start <= until; start += 5) {
    const m = start + 2.5;
    let cum = 0;
    for (let b = 0; b < BUCKETS; b++) cum += perBucket[b]! * Math.min(1, Math.max(0, (m - b * 30) / 30));
    rows.push({
      symbol,
      bucketStart: at(session, start),
      putVolume: Math.round(cum * 0.4),
      callVolume: Math.round(cum * 0.6),
      putPremium: 0,
      callPremium: 0,
      putCallRatio: 0.67,
      underlying: Number((price + perMin * m).toFixed(4)),
    });
  }
  return rows;
}

async function wipe(): Promise<void> {
  await db.intradayProfile.deleteMany({});
  await db.alert.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  await db.flowSnapshot.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  await db.dailyMetric.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  await db.earningsEvent.deleteMany({ where: { symbol: { in: SYMBOLS } } });
}

describe.skipIf(!RUN)('time-of-day learning (RUN_DB_TESTS=1)', () => {
  const engine = new FlowEngine();

  beforeAll(async () => {
    for (const symbol of SYMBOLS) {
      await db.ticker.upsert({ where: { symbol }, create: { symbol, sector: 'Technology' }, update: {} });
    }
    await wipe();
    await db.flowSnapshot.createMany({
      data: [
        ...[WED, THU, MON].flatMap((d) => snapshots('AAPL', d, FRONT, 200, 0.01)), // rises 1c a minute
        ...snapshots('AAPL', FRI, BACK, 200, 0.01),
        ...[WED, THU, FRI, MON].flatMap((d) => snapshots('SPY', d, FRONT, 500, 0)), // flat
        ...snapshots('MSFT', WED, FRONT, 400, 0, 270), // the feed dropped out at 2pm: not a whole session
      ],
    });
    // AAPL reported after Wednesday's close: Thursday is its earnings session.
    await db.earningsEvent.create({
      data: { symbol: 'AAPL', date: utc(WED), source: 'manual', confirmed: true, reportTiming: 'amc' },
    });
    await db.dailyMetric.createMany({
      data: [THU, FRI, MON].flatMap((d) => [
        { symbol: 'AAPL', date: utc(d), close: d === FRI ? 210 : 203.9, final: true },
        { symbol: 'SPY', date: utc(d), close: 500, final: true },
      ]),
    });
    await db.alert.createMany({
      data: [
        { id: 'zz-morning', createdAt: at(THU, 62) }, // 10:32, call-heavy
        { id: 'zz-afterbell', createdAt: at(THU, 397) }, // 4:07pm
        { id: 'zz-today', createdAt: at(MON, 302) }, // 2:32pm today: the next session has not happened
        { id: 'zz-old', createdAt: new Date(NOW.getTime() - 30 * 86_400_000) },
      ].map((a) => ({
        ...a,
        symbol: 'AAPL',
        level: 'elevated',
        message: 'test',
        volumeMultiple: 3,
        premium: 1e6,
        contracts: 500,
        putCallRatio: 0.5,
      })),
    });
  });
  afterAll(async () => {
    if (!RUN) return;
    await wipe();
    await db.$disconnect();
  });

  it('folds each finished session into the right kind of day, once', async () => {
    expect(await foldIntradayProfiles(NOW)).toEqual({ sessions: 4, profiles: 8 }); // AAPL ×4, SPY ×4; MSFT's half day is not learned
    const rows = await db.intradayProfile.findMany({ where: { symbol: 'AAPL' } });
    const byType = Object.fromEntries(rows.map((r) => [r.dayType, r]));
    expect(byType.regular!.sessions).toBe(2); // Wednesday and Monday
    expect(byType.earnings!.sessions).toBe(1); // Thursday
    expect(byType.expiry!.sessions).toBe(1); // Friday
    expect(byType.regular!.lastSession.toISOString().slice(0, 10)).toBe(MON);
    const first = (byType.regular!.putSum[0]! + byType.regular!.callSum[0]!) / byType.regular!.weight;
    expect(first).toBeCloseTo(400 / 1050, 1); // 5-minute snapshots blur a half-hour edge slightly
    expect(byType.regular!.putSum[0]! / (byType.regular!.putSum[0]! + byType.regular!.callSum[0]!)).toBeCloseTo(0.4, 2);
    expect(await db.intradayProfile.count({ where: { symbol: 'MSFT' } })).toBe(0);

    expect(await foldIntradayProfiles(NOW)).toEqual({ sessions: 0, profiles: 0 });
    expect((await db.intradayProfile.findFirst({ where: { symbol: 'AAPL', dayType: 'regular' } }))!.sessions).toBe(2);
  });

  it('does not fold today before the end-of-day capture has finished', async () => {
    await db.intradayProfile.deleteMany({});
    const midSession = at(MON, 200);
    expect((await foldIntradayProfiles(midSession)).sessions).toBe(3);
    const last = await db.intradayProfile.aggregate({ _max: { lastSession: true } });
    expect(last._max.lastSession!.toISOString().slice(0, 10)).toBe(FRI);
    expect((await foldIntradayProfiles(NOW)).sessions).toBe(1); // …and picks it up afterwards
  });

  it('hands the spike detector each name’s clock for the kind of day it is', async () => {
    expect(await loadClocksIntoEngine(engine, NOW)).toBeGreaterThan(0);
    expect(engine.clocksAsOf).toBe(MON);
    engine.detector.setBaseline('AAPL', {
      avgDailyVolume: 10_000,
      stdDevVolume: 0,
      intradayShape: DEFAULT_INTRADAY_SHAPE,
      sampleDays: 20,
    });
    // By 10:00 on a regular day AAPL has usually done far more than the fixed curve's 14%.
    const regular = engine.detector.expectedVolume('AAPL', at('2026-03-17', 30));
    expect(regular).toBeGreaterThan(1_800);
    expect(regular).toBeLessThan(3_810); // …but two sessions do not outweigh its sector yet
    // On the week's last session its clock is back-loaded: less by 10:00, more in the last hour.
    const expiry = engine.detector.expectedVolume('AAPL', at('2026-03-20', 30));
    expect(expiry).toBeLessThan(regular);
    expect(engine.detector.dayType('AAPL', at(THU, 30))).toBe('earnings');
    // A tracked name with no sessions of its own gets its sector's clock, not the fixed curve.
    engine.detector.setBaseline('NVDA', {
      avgDailyVolume: 10_000,
      stdDevVolume: 0,
      intradayShape: DEFAULT_INTRADAY_SHAPE,
      sampleDays: 20,
    });
    expect(engine.detector.expectedVolume('NVDA', at('2026-03-17', 30))).toBeGreaterThan(1_500);
  });

  it('reports a name’s clock beside what it traded on its latest session', async () => {
    const r = await loadClockReport(engine, 'AAPL', NOW);
    expect(r).toMatchObject({
      learned: true,
      session: MON,
      dayType: 'regular',
      ownSessions: { regular: 2, expiry: 1, earnings: 1 },
    });
    expect(r.buckets).toHaveLength(13);
    expect(r.buckets[0]).toMatchObject({ label: '9:30', partial: false });
    expect(Math.abs(r.buckets[0]!.actual! - 400)).toBeLessThan(15);
    expect(r.buckets.reduce((a, b) => a + (b.actual ?? 0), 0)).toBeCloseTo(1_050, 6);
    expect(r.buckets[0]!.actualPutShare).toBeCloseTo(0.4, 2);
    expect(r.buckets[0]!.expected).toBeCloseTo(10_000 * r.buckets[0]!.share, 6);
    expect(r.buckets.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 9);
    expect(r.throughMin).toBe(390);
  });

  it('grades alerts from stored prices: intraday at once, the next day when it has settled', async () => {
    expect(await gradeSpikeAlerts(NOW)).toEqual({ intraday: 3, finished: 3 });
    const byId = Object.fromEntries((await db.alert.findMany({ where: { symbol: 'AAPL' } })).map((a) => [a.id, a]));

    const morning = byId['zz-morning']!;
    expect(morning.gradeStage).toBe(2);
    expect(morning.priceAt).toBeCloseTo(200.625, 6);
    expect(morning.move30m).toBeCloseTo((200.925 / 200.625 - 1) * 100, 2);
    expect(morning.move2h).toBeCloseTo((201.825 / 200.625 - 1) * 100, 2);
    expect(morning.moveClose).toBeCloseTo((203.9 / 200.625 - 1) * 100, 2);
    expect(morning.moveNext).toBeCloseTo((210 / 200.625 - 1) * 100, 2);
    expect(morning.spy30m).toBeCloseTo(0, 6);

    const afterBell = byId['zz-afterbell']!;
    expect(afterBell).toMatchObject({ gradeStage: 2, priceAt: 203.9, move30m: null, moveClose: null });
    expect(afterBell.moveNext).toBeCloseTo((210 / 203.9 - 1) * 100, 2);

    const today = byId['zz-today']!;
    expect(today.gradeStage).toBe(1); // waiting for tomorrow's close
    expect(today.move30m).not.toBeNull();
    expect(today.move2h).toBeNull(); // 2:32pm + 2h is after the bell
    expect(today.moveClose).toBeCloseTo((203.9 / 203.025 - 1) * 100, 2);
    expect(today.moveNext).toBeNull();

    expect(byId['zz-old']).toMatchObject({ gradeStage: 2, priceAt: null }); // too old to price: given up, never learned from

    // Nothing new to do until Tuesday's close exists.
    expect(await gradeSpikeAlerts(NOW)).toEqual({ intraday: 0, finished: 0 });
    await db.dailyMetric.createMany({
      data: [
        { symbol: 'AAPL', date: utc('2026-03-17'), close: 205, final: true },
        { symbol: 'SPY', date: utc('2026-03-17'), close: 505, final: true },
      ],
    });
    expect(await gradeSpikeAlerts(new Date(NOW.getTime() + 86_400_000))).toEqual({ intraday: 0, finished: 1 });
    const finished = await db.alert.findUnique({ where: { id: 'zz-today' } });
    expect(finished!.moveNext).toBeCloseTo((205 / 203.025 - 1) * 100, 2);
    expect(finished!.spyNext).toBeCloseTo(1, 2);
  });

  it('tallies graded alerts into the book and reports a name’s recent ones', async () => {
    expect(await loadSpikeBookIntoEngine(engine, NOW)).toBe(3); // the ungradeable one is not an episode
    const r = await loadSpikeReport(engine, 'AAPL');
    expect(r.tables.map((t) => t.level)).toEqual(['ticker', 'sector', 'all']);
    expect(r.tables[0]!.rows.find((row) => row.part === 'morning' && row.lean === 'calls')!.n).toBe(1);
    expect(r.tables[0]!.rows[0]!.cells.close.rate).toBeNull(); // three spikes are far too few to quote
    expect(r.recent).toHaveLength(4);
    // Breadth recorded when an alert fired is graded apart: the morning one was sector-wide.
    await db.alert.update({ where: { id: 'zz-morning' }, data: { sectorSpiking: 6, sectorNames: 60 } });
    await db.alert.update({ where: { id: 'zz-today' }, data: { sectorSpiking: 1, sectorNames: 60 } });
    await loadSpikeBookIntoEngine(engine, NOW);
    const breadth = (await loadSpikeSummary(engine)).breadth;
    expect(breadth.find((b) => b.kind === 'crowd' && b.lean === 'calls')!.n).toBe(1);
    expect(breadth.find((b) => b.kind === 'lone' && b.lean === 'calls')!.n).toBe(1);
    expect(r.recent[0]).toMatchObject({ part: 'afternoon', lean: 'calls', pending: false });
  });
});
