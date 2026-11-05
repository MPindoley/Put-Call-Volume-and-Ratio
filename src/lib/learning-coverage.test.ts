import { describe, expect, it } from 'vitest';
import {
  classifyCoverage,
  summarizeCoverage,
  type CoverageInput,
  type CoverageThresholds,
  type StockCoverage,
} from './learning-coverage';

const texts = (r: StockCoverage): string[] => r.issues.map((i) => i.text);

const T: CoverageThresholds = { zMinObs30: 20, zMinObs90: 60, stockSignals: 80, projectionPeriods: 3 };

/** A stock captured every session for 120 sessions, with everything flowing. */
const healthy = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  symbol: 'AAPL',
  sector: 'Technology',
  isEtf: false,
  hasCohort: true,
  captured: 120,
  firstAgo: 119,
  lastAgo: 0,
  recent: 20,
  recentWithOptions: 20,
  frozen: false,
  relRows: 120,
  z30Rows: 100,
  z90Rows: 60,
  signalsLogged: 150,
  signalsGraded: 90,
  projection: { week: 20, month: 4 },
  ...over,
});

describe('classifyCoverage', () => {
  it('marks a stock with everything flowing ready at every stage, with no issues', () => {
    const r = classifyCoverage(healthy(), T, 120);
    expect(r.stages).toEqual({ capture: 'ready', options: 'ready', sector: 'ready', signals: 'ready', projection: 'ready' });
    expect(texts(r)).toEqual([]);
  });

  it('says warming, not problem, while a stage is still collecting', () => {
    const r = classifyCoverage(
      healthy({
        captured: 30,
        firstAgo: 29,
        relRows: 30,
        z30Rows: 10,
        z90Rows: 0,
        signalsGraded: 12,
        projection: { week: 1, month: 0 },
      }),
      T,
      30,
    );
    expect(r.stages).toEqual({
      capture: 'ready',
      options: 'ready',
      sector: 'warming',
      signals: 'warming',
      projection: 'warming',
    });
    expect(texts(r)).toEqual([]);
  });

  it('does not count sessions before a newly listed stock was first captured as gaps', () => {
    const r = classifyCoverage(
      healthy({ captured: 6, firstAgo: 5, recent: 6, recentWithOptions: 6, relRows: 6, z30Rows: 0 }),
      T,
      120,
    );
    expect(r.stages.capture).toBe('ready');
    expect(texts(r)).toEqual([]);
  });

  it('flags a stock that stopped trading: frozen price, or no recent capture', () => {
    expect(texts(classifyCoverage(healthy({ frozen: true }), T, 120))[0]).toMatch(/price unchanged over its last 5 captures/);
    const stale = classifyCoverage(healthy({ lastAgo: 12, recent: 8, recentWithOptions: 8 }), T, 120);
    expect(stale.stages.capture).toBe('problem');
    expect(texts(stale)[0]).toMatch(/not captured in the last 12 sessions/);
  });

  it('flags gaps, missing options data, and a stock never captured', () => {
    expect(texts(classifyCoverage(healthy({ recent: 14, recentWithOptions: 14 }), T, 120))).toEqual([
      'captured on 14 of the last 20 sessions',
    ]);
    expect(texts(classifyCoverage(healthy({ recentWithOptions: 6 }), T, 120))).toEqual([
      'IV, skew or open interest missing on 14 of its last 20 captures',
    ]);
    const never = classifyCoverage(
      healthy({ captured: 0, firstAgo: null, lastAgo: null, recent: 0, recentWithOptions: 0, relRows: 0 }),
      T,
      120,
    );
    expect(never.stages.capture).toBe('problem');
    expect(texts(never)).toContain('never captured — no session has saved its options data');
  });

  it('flags data that is captured but never reaches the sector comparison', () => {
    expect(texts(classifyCoverage(healthy({ hasCohort: false }), T, 120))[0]).toMatch(/no sector peer group/);
    expect(texts(classifyCoverage(healthy({ relRows: 0, z30Rows: 0, z90Rows: 0 }), T, 120))).toEqual([
      '120 captured sessions but no sector comparison rows',
    ]);
    expect(texts(classifyCoverage(healthy({ z30Rows: 0, z90Rows: 0 }), T, 120))).toEqual([
      '120 sessions of sector spreads but no z-scores computed',
    ]);
  });

  it('treats ETFs as benchmarks: no sector comparison or directional learning expected', () => {
    const r = classifyCoverage(healthy({ symbol: 'SPY', sector: 'ETF', isEtf: true, hasCohort: false, relRows: 0 }), T, 120);
    expect(r.stages.sector).toBe('n/a');
    expect(r.stages.signals).toBe('n/a');
    expect(texts(r)).toEqual([]);
  });

  it('expects nothing before the site has captured a session', () => {
    const r = classifyCoverage(
      healthy({ captured: 0, firstAgo: null, lastAgo: null, recent: 0, recentWithOptions: 0, relRows: 0 }),
      T,
      0,
    );
    expect(r.stages.capture).toBe('warming');
    expect(texts(r)).toEqual([]);
  });
});

describe('summarizeCoverage', () => {
  it('counts each stage and groups the stocks needing attention by kind, most urgent first', () => {
    const rows = [
      classifyCoverage(healthy({ symbol: 'AAA' }), T, 120),
      classifyCoverage(healthy({ symbol: 'BBB', frozen: true, recentWithOptions: 2 }), T, 120),
      classifyCoverage(healthy({ symbol: 'CCC', hasCohort: false }), T, 120),
      classifyCoverage(
        healthy({ symbol: 'NEW', captured: 0, firstAgo: null, lastAgo: null, recent: 0, recentWithOptions: 0, relRows: 0 }),
        T,
        120,
      ),
      classifyCoverage(healthy({ symbol: 'SPY', sector: 'ETF', isEtf: true, hasCohort: false }), T, 120),
    ];
    const s = summarizeCoverage(rows, 120, '2026-11-04', T);
    expect(s.stages.capture).toEqual({ ready: 3, warming: 0, problem: 2, 'n/a': 0 });
    expect(s.stages.sector).toEqual({ ready: 2, warming: 1, problem: 1, 'n/a': 1 }); // NEW: nothing to compare yet
    expect(s.attention.map((g) => [g.label, g.stocks.map((x) => x.symbol)])).toEqual([
      ['Stopped updating', ['BBB']],
      ['Options data incomplete', ['BBB']],
      ['Not reaching the sector comparison', ['CCC']],
      ['Never captured', ['NEW']],
    ]);
  });
});
