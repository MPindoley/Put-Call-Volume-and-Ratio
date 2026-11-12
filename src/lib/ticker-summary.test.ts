import { describe, expect, it } from 'vitest';
import type { TrackRecord } from './learning-data';
import type { CalibrationView } from './projection-history';
import type { ExpiryProjection, Projection } from './projection';
import {
  expiryNear,
  flowLean,
  glanceSentence,
  glanceTiles,
  paceText,
  range68,
  sectionHeadlines,
  sectionList,
  widestZ,
  type GlanceTile,
  type SummaryInput,
} from './ticker-summary';
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

describe('paceText', () => {
  it('prints the pace against usual volume', () => {
    expect(paceText(1.44)).toBe('1.4×');
    expect(paceText(49.36)).toBe('49.4×');
  });
  it('says nothing when the pace is unmeasured or rounds to zero', () => {
    expect(paceText(0)).toBeNull();
    expect(paceText(0.03)).toBeNull();
    expect(paceText(Number.NaN)).toBeNull();
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

describe('glanceTiles', () => {
  const tile = (input: SummaryInput, id: GlanceTile['id']): GlanceTile => glanceTiles(input).find((t) => t.id === id)!;

  it('always returns the six tiles in reading order', () => {
    expect(glanceTiles(inputOf()).map((t) => t.id)).toEqual(['flow', 'positioning', 'pricing', 'move', 'lean', 'coming']);
  });

  it('says "no data yet" and offers nothing to open when an input is missing', () => {
    const input = inputOf({ flow: flowOf({ putCallRatio: Number.NaN, volumeVsExpected: 0 }) });
    expect(tile(input, 'flow')).toMatchObject({ verdict: 'No flow yet', tone: 'muted' });
    for (const id of ['positioning', 'pricing', 'move'] as const) {
      expect(tile(input, id)).toMatchObject({ verdict: 'No data yet', tone: 'muted', section: null });
    }
    expect(tile(input, 'lean')).toMatchObject({ verdict: 'No signal today', section: null });
    expect(tile(input, 'coming')).toMatchObject({ verdict: 'Nothing dated', section: null });
  });

  it('colours the flow by its lean, but never for an inverse product', () => {
    expect(tile(inputOf(), 'flow')).toMatchObject({
      verdict: 'Call-heavy',
      detail: 'P/C 0.40 · 1.4× usual volume',
      tone: 'bullish',
      section: 'overview',
    });
    expect(tile(inputOf({ flow: flowOf({ putCallRatio: 1.6 }) }), 'flow').tone).toBe('bearish');
    expect(tile(inputOf({ flow: flowOf({ inverse: true }) }), 'flow').tone).toBe('neutral');
    expect(tile(inputOf({ flow: flowOf({ putCallRatio: 0.8, spikeLevel: 'extreme' }) }), 'flow')).toMatchObject({
      verdict: 'Balanced',
      detail: 'P/C 0.80 · 1.4× usual volume · extreme activity',
      tone: 'caution',
    });
  });

  it('reads positioning against the stock’s own range, once it has one', () => {
    const analytics = { oiPutCall: 1.4 } as TickerFlow['analytics'];
    expect(tile(inputOf({ flow: flowOf({ analytics }) }), 'positioning')).toMatchObject({
      verdict: 'OI P/C 1.40',
      detail: 'Still learning its usual range',
    });
    const own = { lo: 0.5, mid: 0.8, hi: 1.1, n: 60 };
    expect(tile(inputOf({ flow: flowOf({ analytics, ownPc: own }) }), 'positioning')).toMatchObject({
      verdict: 'Unusually put-heavy',
      detail: 'OI P/C 1.40 · usually 0.50–1.10',
      tone: 'caution',
      section: 'volatility',
    });
    const normal = { oiPutCall: 0.9 } as TickerFlow['analytics'];
    expect(tile(inputOf({ flow: flowOf({ analytics: normal, ownPc: own }) }), 'positioning')).toMatchObject({
      verdict: 'Normal for it',
      tone: 'neutral',
    });
  });

  it('calls options expensive, cheap or typical by the stock’s own IV rank', () => {
    const at = (ivRank: number | null): GlanceTile =>
      tile(inputOf({ flow: flowOf({ iv30: 42.13, hv20: 35, ivRank }) }), 'pricing');
    expect(at(81)).toMatchObject({
      verdict: 'Expensive for it',
      detail: 'IV 42.1 · rank 81 of 100 · realized 35.0',
      tone: 'caution',
    });
    expect(at(12).verdict).toBe('Cheap for it');
    expect(at(50)).toMatchObject({ verdict: 'Typical for it', tone: 'neutral' });
    expect(at(null)).toMatchObject({ verdict: 'IV 42.1', detail: 'Rank builds with stored history · realized 35.0' });
  });

  it('gives the week’s expected move, with how real moves have compared once that is known', () => {
    const projection = projectionOf([expiryOf('2026-11-20', 9, 95, 105)]);
    expect(tile(inputOf({ projection }), 'move')).toMatchObject({
      verdict: '±5.0% by Nov 20',
      detail: '68% range $95.0–$105',
      section: 'projection',
    });
    const cal = (usable: boolean): CalibrationView => ({ ratio: 0.85, usable, tickerWeight: 0.4 }) as CalibrationView;
    const calibrated = (usable: boolean): string =>
      tile(inputOf({ projection, calibration: { week: cal(usable), month: cal(usable) } }), 'move').detail;
    expect(calibrated(true)).toBe('68% range $95.0–$105 · real moves have run 0.85× priced');
    expect(calibrated(false)).toBe('68% range $95.0–$105');
  });

  it('falls back to the nearest-expiry straddle without a projection', () => {
    const analytics = { oiPutCall: null, impliedMovePct: 4.37 } as TickerFlow['analytics'];
    expect(tile(inputOf({ flow: flowOf({ analytics }) }), 'move')).toMatchObject({ verdict: '±4.4%', section: 'volatility' });
  });

  it('states the learned lean and how long its strongest signal has taken', () => {
    const conviction: TickerFlow['conviction'] = {
      score: 0.062,
      direction: 'bullish',
      asOf: '2026-11-10',
      parts: [
        { signalType: 'skew_z', direction: 'bullish', edge: 0.02, n: 40 },
        { signalType: 'pc_extreme', direction: 'bullish', edge: 0.07, n: 60 },
      ],
    };
    const trackRecord = {
      horizon: 10,
      basis: 'excess',
      bySignal: [],
      recent: [],
      learned: [
        {
          signalType: 'skew_z',
          direction: 'bullish',
          asOf: '2026-11-10',
          edge: 0.02,
          path: [],
          timing: { verdict: 'slow', best: 20 },
        },
        {
          signalType: 'pc_extreme',
          direction: 'bullish',
          asOf: '2026-11-10',
          edge: 0.07,
          path: [],
          timing: { verdict: 'mid', best: 10 },
        },
      ],
      note: null,
    } as unknown as TrackRecord;
    expect(tile(inputOf({ flow: flowOf({ conviction }), trackRecord }), 'lean')).toMatchObject({
      verdict: 'Bullish +6.2 pts',
      detail: '2 signals · plays out over ~2 weeks',
      tone: 'bullish',
      section: 'track-record',
    });
    const flat = { ...conviction, direction: null, score: 0.001 };
    expect(tile(inputOf({ flow: flowOf({ conviction: flat }) }), 'lean')).toMatchObject({
      verdict: 'No clear lean',
      tone: 'neutral',
    });
  });

  it('shows the next catalyst, or the last unusual move when nothing is dated', () => {
    const eventGauge = {
      eventDate: '2026-11-19',
      eventSource: 'bulge',
      reportTiming: 'bmo',
      impliedMove: 0.0612,
      display: true,
      percentile: 20,
    } as NonNullable<TickerFlow['eventGauge']>;
    expect(tile(inputOf({ flow: flowOf({ eventGauge }) }), 'coming')).toMatchObject({
      verdict: 'Possible catalyst Nov 19',
      detail: 'Before the open · ±6.1% priced · cheap vs past',
      tone: 'caution',
      section: 'event',
    });
    const moved = flowOf({ idiosyncraticMoves: [{ date: '2026-10-28', movePct: 0.052, residualZ: 4.1 }] });
    expect(tile(inputOf({ flow: moved }), 'coming')).toMatchObject({
      verdict: 'Nothing dated',
      detail: 'Last unusual move ±5.2% on Oct 28',
      section: 'idiosyncratic',
    });
  });
});

describe('glanceSentence', () => {
  it('always covers the flow and the lean', () => {
    expect(glanceSentence(inputOf())).toBe('Options flow is call-heavy on 1.4× its usual volume. No learned lean today.');
  });

  it('adds only what stands out, then what is priced ahead', () => {
    const flow = flowOf({
      putCallRatio: 1.5,
      volumeVsExpected: 2.6,
      conviction: { score: -0.04, direction: 'bearish', asOf: '2026-11-10', parts: [] },
      analytics: { oiPutCall: 1.4 } as TickerFlow['analytics'],
      ownPc: { lo: 0.5, mid: 0.8, hi: 1.1, n: 60 },
      iv30: 40,
      ivRank: 88,
      eventGauge: { eventDate: '2026-11-19', eventSource: 'manual', impliedMove: 0.061 } as NonNullable<TickerFlow['eventGauge']>,
    });
    const projection = projectionOf([expiryOf('2026-11-20', 9, 95, 105)]);
    expect(glanceSentence(inputOf({ flow, projection }))).toBe(
      'Options flow is put-heavy on 2.6× its usual volume. The learned lean is bearish (−4.0 pts). ' +
        'Positioning is unusually put-heavy for this stock. Options are expensive by its own standard (IV rank 88). ' +
        'Options price about ±5.0% by Fri, Nov 20. A catalyst is dated Nov 19 (±6.1% priced).',
    );
  });

  it('stays quiet about positioning and option prices that are normal', () => {
    const flow = flowOf({
      analytics: { oiPutCall: 0.8 } as TickerFlow['analytics'],
      ownPc: { lo: 0.5, mid: 0.8, hi: 1.1, n: 60 },
      iv30: 30,
      ivRank: 50,
    });
    expect(glanceSentence(inputOf({ flow }))).toBe('Options flow is call-heavy on 1.4× its usual volume. No learned lean today.');
  });
});

describe('sectionList', () => {
  const ids = (input: SummaryInput): string[] => sectionList(input).map((d) => d.id);

  it('always has the sections every stock has, in reading order', () => {
    expect(ids(inputOf())).toEqual(['projection', 'overview', 'relative', 'time-of-day', 'relationships', 'history']);
  });

  it('adds a section only when the stock has something for it', () => {
    const flow = flowOf({
      iv30: 30,
      eventGauge: { eventDate: '2026-11-19' } as NonNullable<TickerFlow['eventGauge']>,
      idiosyncraticMoves: [{ date: '2026-10-28', movePct: 0.05, residualZ: 4 }],
    });
    const trackRecord = { horizon: 10, bySignal: [], recent: [], learned: [], note: null } as unknown as TrackRecord;
    expect(ids(inputOf({ flow, trackRecord }))).toEqual([
      'projection',
      'overview',
      'volatility',
      'relative',
      'track-record',
      'event',
      'idiosyncratic',
      'time-of-day',
      'relationships',
      'history',
    ]);
  });
});

describe('a closed or just-restarted market', () => {
  it('never prints a pace of 0.0×', () => {
    const input = inputOf({ flow: flowOf({ volumeVsExpected: 0.03 }) });
    expect(sectionHeadlines(input).overview).toBe('P/C 0.40 · net 600 calls per 5 min');
    expect(glanceTiles(input)[0]!.detail).toBe('P/C 0.40');
    expect(glanceSentence(input)).toBe('Options flow is call-heavy. No learned lean today.');
  });
});
