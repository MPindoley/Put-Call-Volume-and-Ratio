import { describe, expect, it } from 'vitest';
import { buildEdgeBook, LEARNING_PARAMS, type EdgeBook, type Evidence } from './learning';
import {
  classifyTiming,
  timingAt,
  timingDeepest,
  timingSentence,
  timingShort,
  TIMING_PARAMS,
  type TimingHorizon,
} from './signal-timing';

const e = (e5: number, e10: number, e20: number): Record<TimingHorizon, number> => ({ 5: e5, 10: e10, 20: e20 });
const verdict = (e5: number, e10: number, e20: number, graded = 100): string => {
  const c = classifyTiming(e(e5, e10, e20), graded);
  return `${c.verdict}${c.best === null ? '' : `@${c.best}`}`;
};

describe('classifyTiming', () => {
  it('says nothing before enough signals are graded', () => {
    expect(verdict(0.2, 0.1, 0, TIMING_PARAMS.minGraded - 1)).toBe('learning');
    expect(verdict(0.2, 0.1, 0, TIMING_PARAMS.minGraded)).toBe('fast@5');
  });

  it('reports no timing when there is no edge at any window', () => {
    expect(verdict(0.01, 0.015, -0.01)).toBe('none');
    expect(verdict(0, 0, 0)).toBe('none');
  });

  it('calls a signal fast when the edge is early and gone later', () => {
    expect(verdict(0.06, 0.04, 0.01)).toBe('fast@5');
    expect(verdict(0.05, 0.055, 0.01)).toBe('fast@10'); // there by two weeks, gone by four
  });

  it('calls a signal slow when the edge is late', () => {
    expect(verdict(0.0, 0.03, 0.06)).toBe('slow@20');
    expect(verdict(0.0, 0.05, 0.045)).toBe('slow@10'); // weak in week one, there from week two
  });

  it('names the middle window only when it clears both sides', () => {
    expect(verdict(0.02, 0.06, 0.03)).toBe('mid@10');
  });

  it('refuses to name a best window when none clears the others', () => {
    expect(verdict(0.05, 0.045, 0.04)).toBe('steady');
    expect(verdict(0.04, 0.05, 0.045)).toBe('steady');
    expect(verdict(0.04, 0.045, 0.05)).toBe('steady');
  });

  it('asks more of a thin sample: the floors rise with the standard error', () => {
    const c = (se: number): string => classifyTiming(e(0.03, 0.01, 0.0), 100, se).verdict;
    expect(c(0.01)).toBe('fast'); // 3 points on a tight estimate
    expect(c(0.035)).toBe('none'); // the same 3 points inside one standard error
    // An edge well clear of its error, but the windows closer than half of it: no window is named.
    expect(classifyTiming(e(0.1, 0.095, 0.085), 100, 0.04).verdict).toBe('steady');
    expect(classifyTiming(e(0.1, 0.095, 0.085), 100, 0.01).verdict).toBe('fast');
    expect(classifyTiming(e(-0.03, -0.03, -0.03), 100, 0.035).verdict).toBe('none'); // not clearly wrong either
  });

  it('flags a signal that has pointed the wrong way, at its worst window', () => {
    expect(verdict(-0.01, -0.03, -0.06)).toBe('against@20');
    expect(verdict(-0.05, 0.01, 0.0)).toBe('against@5');
    expect(verdict(-0.05, 0.03, 0.0)).toBe('mid@10'); // a positive edge elsewhere outranks it
  });
});

/** A book in which `hits` of `n` bullish skew_z signals on AAPL hit, against a 50% base. */
function book(hits: number, n: number, symbol = 'AAPL'): EdgeBook {
  const evidence: Evidence[] = Array.from({ length: n }, (_, i) => ({
    signalType: 'skew_z',
    direction: 'bullish',
    regime: 'pos|pos',
    sector: 'Technology',
    symbol,
    firedIdx: 100,
    knownIdx: 100,
    hit: i < hits,
    base: 0.5,
  }));
  return buildEdgeBook(evidence, 100, 'v', LEARNING_PARAMS);
}

describe('timingAt', () => {
  const key = { signalType: 'skew_z', direction: 'bullish' as const, regime: 'pos|pos', sector: 'Technology', symbol: 'AAPL' };
  const books = { 5: book(80, 100), 10: book(60, 100), 20: book(50, 100) };

  it('reads the edge at each window from the same shrinkage as the edge book', () => {
    const t = timingAt(books, key, 'signal');
    expect(t.graded).toBe(100);
    expect(t.windows.map((w) => w.horizon)).toEqual([5, 10, 20]);
    // raw +30 pts on 100 signals against a prior of 40: 0.30 × 100 / 140.
    expect(t.windows[0]!.edge).toBeCloseTo((0.3 * 100) / (100 + LEARNING_PARAMS.prior.signal), 9);
    expect(t.windows[2]!.edge).toBeCloseTo(0, 9);
    expect(t.se).toBeCloseTo(Math.sqrt(0.25 / (100 + LEARNING_PARAMS.prior.signal)), 9);
    expect(t).toMatchObject({ verdict: 'fast', best: 5 });
  });

  it('follows the chain down to the stock, where every level agreeing firms the estimate up', () => {
    const own = timingAt(books, key, 'ticker');
    expect(own.windows[0]!.n).toBe(100);
    expect(own.windows[0]!.edge).toBeGreaterThan(timingAt(books, key, 'signal').windows[0]!.edge);
  });

  it('gives no verdict at a level without enough graded signals of its own', () => {
    const other = timingAt(books, { ...key, symbol: 'MSFT' }, 'ticker'); // MSFT has none: it would only repeat its sector
    expect(other.windows[0]!.edge).toBeCloseTo(timingAt(books, key, 'sector').windows[0]!.edge, 9);
    expect(other).toMatchObject({ graded: 0, verdict: 'learning', best: null });
    const thin = timingAt({ ...books, 20: book(5, 10) }, key, 'signal'); // the fewest any window has
    expect(thin).toMatchObject({ graded: 10, verdict: 'learning' });
    expect(timingAt({ 5: book(0, 0), 10: book(0, 0), 20: book(0, 0) }, key, 'signal')).toMatchObject({
      graded: 0,
      verdict: 'learning',
    });
  });

  it('reads the timing at the most specific level that has the evidence', () => {
    expect(timingDeepest(books, key)).toMatchObject({ level: 'ticker', verdict: 'fast', graded: 100 });
    expect(timingDeepest(books, { ...key, symbol: 'MSFT' })).toMatchObject({ level: 'sector', verdict: 'fast', graded: 100 });
    expect(timingDeepest(books, { ...key, symbol: 'JPM', sector: 'Financials' })).toMatchObject({
      level: 'regime',
      verdict: 'fast',
    });
    expect(timingDeepest(books, { ...key, symbol: 'JPM', sector: 'Financials', regime: 'neg|neg' })).toMatchObject({
      level: 'signal',
      verdict: 'fast',
    });
    const none = { 5: book(3, 6), 10: book(3, 6), 20: book(3, 6) };
    expect(timingDeepest(none, key)).toMatchObject({ level: 'signal', verdict: 'learning', graded: 6 });
  });
});

describe('wording', () => {
  it('has a short label and a sentence for every verdict', () => {
    const cases: [Parameters<typeof timingShort>[0], string][] = [
      [{ verdict: 'learning', best: null }, 'learning'],
      [{ verdict: 'none', best: null }, 'no edge yet'],
      [{ verdict: 'steady', best: null }, '1–4 weeks'],
      [{ verdict: 'mid', best: 10 }, '~2 weeks'],
      [{ verdict: 'fast', best: 5 }, '~1 week'],
      [{ verdict: 'fast', best: 10 }, 'within 2 weeks'],
      [{ verdict: 'slow', best: 10 }, '2+ weeks'],
      [{ verdict: 'slow', best: 20 }, '~4 weeks'],
      [{ verdict: 'against', best: 20 }, 'wrong way'],
    ];
    for (const [t, short] of cases) {
      expect(timingShort(t)).toBe(short);
      expect(timingSentence({ ...t, graded: 12 }).length).toBeGreaterThan(20);
    }
    expect(timingSentence({ verdict: 'learning', best: null, graded: 12 })).toContain('12 graded so far');
    expect(timingSentence({ verdict: 'against', best: 20, graded: 90 })).toContain('20 sessions');
  });
});
