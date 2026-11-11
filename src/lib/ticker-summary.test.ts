import { describe, expect, it } from 'vitest';
import type { TrackRecord } from './learning-data';
import type { ExpiryProjection, Projection } from './projection';
import { expiryNear, flowLean, range68, sectionHeadlines, widestZ, type SummaryInput } from './ticker-summary';
import type { TickerFlow } from '@/types';

export function flowOf(over: Partial<TickerFlow> = {}): TickerFlow {
  return {
    symbol: 'TEST',
    sector: 'Technology',
    putVolume: 400,
    callVolume: 1000,
    sessionPutVolume: 40_000,
    sessionCallVolume: 100_000,
    putCallRatio: 0.4,
    netFlow: 600,
    callPremium: 0,
    putPremium: 0,
    spikeLevel: 'normal',
    spikeScore: 10,
    volumeVsExpected: 1.4,
    ratioSparkline: [],
    underlyingPrice: 100,
    priceChangePct: 0.5,
    livePrice: null,
    livePriceChangePct: null,
    livePriceAt: null,
    sharesOutstanding: null,
    ownPc: null,
    iv30: null,
    iv30Change: null,
    ivRank: null,
    hv20: null,
    oiChangePct: null,
    analytics: null,
    inverse: false,
    leverage: 1,
    oiSignals: null,
    sectorRelative: null,
    conviction: null,
    eventGauge: null,
    idiosyncraticMoves: [],
    lastUpdated: 1,
    dataAsOf: 1,
    flowWindowMs: 300_000,
    realtime: false,
    lastDelta: 'none',
    ...over,
  } as TickerFlow;
}

export function expiryOf(expiration: string, dte: number, lo: number, hi: number): ExpiryProjection {
  const mid = (lo + hi) / 2;
  return {
    expiration,
    dte,
    forward: mid,
    atmIv: 30,
    sigmaMove: (hi - lo) / 2 / mid,
    quantiles: [lo - (hi - lo) / 2, lo, mid, hi, hi + (hi - lo) / 2],
    grid: { price: [], probAbove: [] },
    method: 'smile',
    quotes: 20,
  };
}

export function projectionOf(expiries: ExpiryProjection[], spot = 100): Projection {
  return {
    symbol: 'TEST',
    spot,
    dataAsOf: 1,
    method: 'p1',
    expiries,
    positioning: { callWall: null, putWall: null, gammaFlip: null, gammaAtSpot: null },
  };
}

export function inputOf(over: Partial<SummaryInput> = {}): SummaryInput {
  return { flow: flowOf(), projection: null, calibration: null, trackRecord: null, historyCount: 0, ...over };
}

const relative = (z: Partial<NonNullable<TickerFlow['sectorRelative']>>): NonNullable<TickerFlow['sectorRelative']> =>
  ({
    symbol: 'TEST',
    cohort: 'XLK',
    cohortLabel: 'Technology',
    skewZ30: null,
    skewZ90: null,
    ivZ30: null,
    ivZ90: null,
    oiPcZ30: null,
    oiPcZ90: null,
    ivHvZ30: null,
    ivHvZ90: null,
    windowDays: 90,
    regimeDetach: false,
    regimeDetachMetric: null,
    regimeDetachDir: null,
    divergence: null,
    divergenceWindow: 0,
    priceTrendT: null,
    skewTrendT: null,
    priceTrendTNW: null,
    skewTrendTNW: null,
    ...z,
  }) as NonNullable<TickerFlow['sectorRelative']>;

describe('flowLean', () => {
  it('reads the put/call ratio against the usual single-stock range', () => {
    expect(flowLean(0.4)).toBe('call-heavy');
    expect(flowLean(0.8)).toBe('balanced');
    expect(flowLean(1.5)).toBe('put-heavy');
  });
  it('is unknown when there is no ratio', () => {
    expect(flowLean(Number.NaN)).toBeNull();
    expect(flowLean(0)).toBeNull();
  });
});

describe('expiryNear', () => {
  const week = expiryOf('2026-11-20', 9, 95, 105);
  const lapsing = expiryOf('2026-11-12', 0.4, 99, 101);
  const month = expiryOf('2026-12-18', 37, 90, 110);
  it('picks the expiry closest to the horizon', () => {
    const p = projectionOf([lapsing, week, month]);
    expect(expiryNear(p, 7)?.expiration).toBe('2026-11-20');
    expect(expiryNear(p, 30)?.expiration).toBe('2026-12-18');
  });
  it('skips an expiry about to lapse unless it is the only one', () => {
    expect(expiryNear(projectionOf([lapsing, month]), 1)?.expiration).toBe('2026-12-18');
    expect(expiryNear(projectionOf([lapsing]), 7)?.expiration).toBe('2026-11-12');
  });
  it('has nothing without a projection', () => {
    expect(expiryNear(null, 7)).toBeNull();
    expect(expiryNear(projectionOf([]), 7)).toBeNull();
  });
});

describe('range68', () => {
  it('is the 16th–84th percentile band, with its half-width as a share of the price', () => {
    const r = range68(expiryOf('2026-11-20', 9, 95, 105), 100);
    expect(r.lo).toBe(95);
    expect(r.hi).toBe(105);
    expect(r.pct).toBeCloseTo(0.05, 10);
  });
});

describe('widestZ', () => {
  it('names the metric furthest from its norm, either side', () => {
    const flow = flowOf({ sectorRelative: relative({ skewZ30: 0.4, ivZ30: -2.3, oiPcZ30: 1.1 }) });
    expect(widestZ(flow)).toEqual({ label: 'IV', z: -2.3 });
  });
  it('is null with nothing measured', () => {
    expect(widestZ(flowOf())).toBeNull();
    expect(widestZ(flowOf({ sectorRelative: relative({}) }))).toBeNull();
  });
});

describe('sectionHeadlines', () => {
  it('says what is missing rather than printing empty numbers', () => {
    const h = sectionHeadlines(inputOf({ flow: flowOf({ volumeVsExpected: 0, flowWindowMs: null }) }));
    expect(h.projection).toBe('Waiting for the option chain');
    expect(h.overview).toBe('P/C 0.40');
    expect(h.volatility).toBe('No volatility data yet');
    expect(h.relative).toBe('Builds after the first end-of-day capture');
    expect(h['track-record']).toBe('No signal this session');
    expect(h.history).toBe('No stored snapshots yet');
  });

  it('gives the week and month ranges, once each', () => {
    const week = expiryOf('2026-11-20', 9, 95, 105);
    const month = expiryOf('2026-12-18', 37, 88.5, 112);
    expect(sectionHeadlines(inputOf({ projection: projectionOf([week, month]) })).projection).toBe(
      '68% range $95.0–$105 by Nov 20 · $88.5–$112 by Dec 18',
    );
    expect(sectionHeadlines(inputOf({ projection: projectionOf([week]) })).projection).toBe('68% range $95.0–$105 by Nov 20');
  });

  it('describes the flow: ratio, pace, net side and any unusual activity', () => {
    const h = sectionHeadlines(inputOf({ flow: flowOf({ netFlow: -1500, spikeLevel: 'significant' }) }));
    expect(h.overview).toBe('P/C 0.40 · 1.4× usual volume · net 1.5K puts per 5 min · significant activity');
  });

  it('puts positioning against the stock’s own range', () => {
    const analytics = { oiPutCall: 1.4, backwardated: true } as TickerFlow['analytics'];
    const h = sectionHeadlines(
      inputOf({ flow: flowOf({ iv30: 42.13, ivRank: 81, analytics, ownPc: { lo: 0.5, mid: 0.8, hi: 1.1, n: 60 } }) }),
    );
    expect(h.volatility).toBe('IV30 42.1 (rank 81) · OI P/C 1.40, unusually put-heavy · near-term IV above longer-term');
  });

  it('flags the widest sector gap and any warning', () => {
    const quiet = sectionHeadlines(inputOf({ flow: flowOf({ sectorRelative: relative({ skewZ30: 0.3, ivZ30: -0.6 }) }) }));
    expect(quiet.relative).toBe('In line with its sector');
    const loud = sectionHeadlines(
      inputOf({ flow: flowOf({ sectorRelative: relative({ skewZ30: -2.14, ivZ30: 0.6, divergence: 'distribution' }) }) }),
    );
    expect(loud.relative).toBe('Furthest from its sector: skew −2.1σ · distribution warning');
  });

  it('leads the track record with the learned lean and the stock’s own hit count', () => {
    const conviction: TickerFlow['conviction'] = {
      score: -0.031,
      direction: 'bearish',
      asOf: '2026-11-10',
      parts: [{ signalType: 'skew_z', direction: 'bearish', edge: 0.031, n: 40 }],
    };
    const trackRecord = {
      horizon: 10,
      basis: 'excess',
      bySignal: [
        { signalType: 'skew_z', direction: 'bearish', graded: 12, hits: 7, hitRate: 7 / 12, avgRet: 0.01 },
        { signalType: 'pc_extreme', direction: 'bullish', graded: 8, hits: 5, hitRate: 5 / 8, avgRet: 0.02 },
      ],
      recent: [],
      learned: [],
      note: null,
    } as TrackRecord;
    const h = sectionHeadlines(inputOf({ flow: flowOf({ conviction }), trackRecord }));
    expect(h['track-record']).toBe('Leans bearish −3.1 pts · 1 signal this session · own record 12 of 20 hit');
    const flat = sectionHeadlines(inputOf({ flow: flowOf({ conviction: { ...conviction, direction: null, score: 0.001 } }) }));
    expect(flat['track-record']).toBe('Signals net to no clear lean');
  });

  it('dates the catalyst, the priced move and how it compares with past reactions', () => {
    const eventGauge = {
      eventDate: '2026-11-19',
      eventSource: 'manual',
      reportTiming: 'amc',
      impliedMove: 0.0612,
      impliedMethod: 'pre-event-reference',
      diffusiveVol: 0.3,
      refusedReason: null,
      display: true,
      confirmedCount: 8,
      requiredCount: 6,
      medianRealized: 0.04,
      percentile: 82,
      richCheapRatio: 1.5,
    } as NonNullable<TickerFlow['eventGauge']>;
    expect(sectionHeadlines(inputOf({ flow: flowOf({ eventGauge }) })).event).toBe(
      'Catalyst Nov 19 after the close · ±6.1% priced · rich vs its past reactions',
    );
    const unconfirmed = { ...eventGauge, eventSource: 'bulge', reportTiming: 'unknown', display: false } as typeof eventGauge;
    expect(sectionHeadlines(inputOf({ flow: flowOf({ eventGauge: unconfirmed }) })).event).toBe(
      'Possible catalyst Nov 19 · ±6.1% priced',
    );
  });

  it('counts unusual moves and stored snapshots', () => {
    const h = sectionHeadlines(
      inputOf({
        flow: flowOf({
          idiosyncraticMoves: [
            { date: '2026-10-28', movePct: 0.052, residualZ: 4.1 },
            { date: '2026-09-03', movePct: 0.04, residualZ: 3.2 },
          ],
        }),
        historyCount: 240,
      }),
    );
    expect(h.idiosyncratic).toBe('2 unusual moves on record · latest ±5.2% on Oct 28');
    expect(h.history).toBe('100 stored 5-minute snapshots');
  });
});
