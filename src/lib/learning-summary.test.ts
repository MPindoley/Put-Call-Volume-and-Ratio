import { describe, expect, it } from 'vitest';
import type { Calibration, SignalSummary } from './learning';
import type { CoverageReport } from './learning-coverage';
import type { LearningReport } from './learning-jobs';
import {
  dateSpan,
  flaggedStocks,
  learningHeadlines,
  learningSentence,
  learningTiles,
  type LearningSummaryInput,
  type LearningTile,
} from './learning-summary';
import type { Coverage } from './projection-history';

const grade = (over: Partial<Calibration> = {}): Calibration => ({
  n: 0,
  hitRate: null,
  base: null,
  predicted: null,
  realized: null,
  ci: null,
  skill: null,
  bins: [],
  byMonth: [],
  ...over,
});

function reportOf(selfGrade: Calibration = grade(), signals: Partial<LearningReport['status']['signals']> = {}): LearningReport {
  const level = { established: 2, total: 10 };
  return {
    version: 'v',
    generatedAt: '2026-11-11T00:00:00Z',
    status: {
      sessions: { first: '2025-01-02', last: '2026-11-10', count: 480 },
      captured: { first: '2026-01-05', last: '2026-11-10', count: 212 },
      books: { total: 210, live: 180, reconstructed: 30, latestAsOf: '2026-11-10' },
      signals: {
        logged: 4100,
        graded: 3410,
        pending: 690,
        unbased: 12,
        excludedFrozen: 3,
        nextMaturity: '2026-11-12',
        ...signals,
      },
      established: { signal: level, regime: level, sector: level, ticker: level },
      frozen: { names: 2, top: [] },
    },
    selfGrade,
  };
}

const signal = (signalType: string, direction: 'bullish' | 'bearish', edge: number): SignalSummary => ({
  signalType,
  direction,
  n: 100,
  raw: edge,
  edge,
  se: 0.01,
  evidence: 0.5,
  regimes: [],
});

const coverageOf = (symbols: string[][]): CoverageReport =>
  ({
    sessions: { captured: 212, latest: '2026-11-10' },
    attention: symbols.map((group, i) => ({
      kind: `k${i}`,
      label: `Kind ${i}`,
      stocks: group.map((symbol) => ({ symbol, sector: 'Technology', text: '' })),
    })),
  }) as unknown as CoverageReport;

const graded = (n: number, inside68: number | null): Coverage => ({
  n,
  inside68,
  inside95: null,
  below68: null,
  above68: null,
  calibratedN: 0,
  calibratedInside68: null,
});

const inputOf = (over: Partial<LearningSummaryInput> = {}): LearningSummaryInput => ({
  report: null,
  signals: null,
  combos: null,
  coverage: null,
  intraday: null,
  projection: null,
  ...over,
});

describe('learningHeadlines', () => {
  it('says what each section holds before anything has loaded or been learned', () => {
    expect(learningHeadlines(inputOf())).toEqual({
      signals: 'Nothing graded yet',
      together: 'Built with the next nightly run',
      'self-grade': 'No graded calls yet',
      'time-of-day': 'When stocks trade through the day · what followed spike alerts',
      projection: 'No graded projections yet',
      coverage: 'Whether each stock’s data is reaching the learning',
      health: 'What was left out of the learning, and why',
    });
  });

  it('names the strongest signal', () => {
    const signals = [
      signal('skew_z', 'bullish', 0.031),
      signal('pc_extreme', 'bullish', 0.092),
      signal('spike_alert', 'bearish', -0.02),
    ];
    expect(learningHeadlines(inputOf({ signals })).signals).toBe(
      '3 signals tracked · strongest: OI put/call extreme bullish +9.2 pts',
    );
  });

  it('counts the pairs by verdict, leaving out the empty ones', () => {
    const pairs = (['stronger', 'same', 'learning', 'learning'] as const).map((verdict) => ({ verdict }));
    expect(learningHeadlines(inputOf({ combos: { pairs } })).together).toBe(
      '4 pairs seen together · 1 stronger together · 2 still learning',
    );
    expect(learningHeadlines(inputOf({ combos: { pairs: [] } })).together).toBe('No two signals have fired together yet');
  });

  it('puts delivered beside claimed for the self-grade', () => {
    const report = reportOf(grade({ n: 1204, hitRate: 0.541, base: 0.5, predicted: 0.03, realized: 0.041 }));
    expect(learningHeadlines(inputOf({ report }))['self-grade']).toBe(
      'Right 54% of the time vs 50% on an ordinary day · +4.1 pts delivered vs +3.0 claimed',
    );
  });

  it('reports the clocks, the graded ranges, coverage and what was left out', () => {
    const h = learningHeadlines(
      inputOf({
        report: reportOf(),
        intraday: { clock: { names: 1400, withOwnData: 412 }, spikes: { episodes: 87, pending: 4 } },
        projection: { week: graded(2800, 0.74), month: graded(0, null) },
        coverage: coverageOf([['AAA', 'BBB'], ['BBB']]),
      }),
    );
    expect(h['time-of-day']).toBe('412 of 1,400 stocks have sessions of their own · 87 spike alerts graded');
    expect(h.projection).toBe('1-week 68% ranges held 74% (2,800 graded)');
    expect(h.coverage).toBe('2 stocks need attention · 212 sessions captured');
    expect(h.health).toBe('15 signals left out · 2 stocks with frozen prices');
  });

  it('says so when every stock is covered', () => {
    expect(learningHeadlines(inputOf({ coverage: coverageOf([]) })).coverage).toBe(
      'Every stock is reaching every stage · 212 sessions captured',
    );
  });
});

describe('dateSpan', () => {
  it('shows the years only when the span crosses one', () => {
    expect(dateSpan('2026-08-03', '2026-11-10')).toBe('Aug 3 – Nov 10');
    expect(dateSpan('2025-12-01', '2026-11-10')).toBe('Dec 1 2025 – Nov 10 2026');
  });
});

describe('flaggedStocks', () => {
  it('counts a stock once however many problems it has', () => {
    expect(
      flaggedStocks(
        coverageOf([
          ['AAA', 'BBB'],
          ['BBB', 'CCC'],
        ]),
      ),
    ).toBe(3);
    expect(flaggedStocks(null)).toBe(0);
  });
});

describe('learningTiles', () => {
  const tile = (input: LearningSummaryInput, id: LearningTile['id']): LearningTile =>
    learningTiles(input).find((t) => t.id === id)!;

  it('has nothing to show without a report', () => {
    expect(learningTiles(inputOf())).toEqual([]);
  });

  it('gives six tiles, the self-grade first', () => {
    const tiles = learningTiles(inputOf({ report: reportOf() }));
    expect(tiles.map((t) => t.id)).toEqual(['grade', 'graded', 'pending', 'established', 'captured', 'snapshots']);
  });

  it('will not grade itself before any call has been graded', () => {
    expect(tile(inputOf({ report: reportOf() }), 'grade')).toMatchObject({
      verdict: 'Too early to say',
      tone: 'muted',
      section: 'self-grade',
    });
  });

  it('colours the self-grade by whether it delivered', () => {
    const good = reportOf(grade({ n: 1204, hitRate: 0.54, base: 0.5, predicted: 0.03, realized: 0.041 }));
    expect(tile(inputOf({ report: good }), 'grade')).toMatchObject({
      verdict: '+4.1 pts delivered',
      detail: 'claimed +3.0 · 1,204 graded calls',
      tone: 'bullish',
    });
    const bad = reportOf(grade({ n: 300, hitRate: 0.48, base: 0.5, predicted: 0.03, realized: -0.02 }));
    expect(tile(inputOf({ report: bad }), 'grade')).toMatchObject({ verdict: '−2.0 pts delivered', tone: 'bearish' });
  });

  it('adds up the evidence', () => {
    const input = inputOf({ report: reportOf() });
    expect(tile(input, 'graded')).toMatchObject({ verdict: '3,410', detail: 'of 4,100 logged' });
    expect(tile(input, 'pending')).toMatchObject({ verdict: '690', detail: 'next due Nov 12' });
    expect(tile(input, 'established').verdict).toBe('8 / 40');
    expect(tile(input, 'captured')).toMatchObject({ verdict: '212', detail: 'Jan 5 – Nov 10', section: 'coverage' });
    expect(tile(input, 'snapshots')).toMatchObject({ verdict: '210', detail: '180 live · 30 rebuilt', section: null });
  });
});

describe('learningSentence', () => {
  it('is empty without a report', () => {
    expect(learningSentence(inputOf())).toBe('');
  });

  it('leads with the self-grade, then the evidence, then anything needing attention', () => {
    const report = reportOf(grade({ n: 1204, hitRate: 0.541, base: 0.5, predicted: 0.03, realized: 0.041 }));
    expect(learningSentence(inputOf({ report, coverage: coverageOf([['AAA']]) }))).toBe(
      'Over 1,204 graded calls, the app’s leans were right 54% of the time against 50% on an ordinary day: +4.1 points delivered, +3.0 claimed. ' +
        '3,410 signals graded so far, 690 waiting for their window to close. 1 stock needs attention on data coverage.',
    );
  });

  it('says plainly when nothing has been graded yet', () => {
    expect(learningSentence(inputOf({ report: reportOf() }))).toBe(
      'None of the app’s own calls has been graded yet — that starts 10 sessions after the first lean is shown. ' +
        '3,410 signals graded so far, 690 waiting for their window to close.',
    );
  });
});
