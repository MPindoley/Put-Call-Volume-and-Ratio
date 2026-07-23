import { describe, expect, it } from 'vitest';
import {
  computeMarketWideDates,
  detectIdiosyncraticEvents,
  type DailyClose,
} from './idiosyncratic';

function isoSeq(n: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Build a benchmark, a subject ticker (= 1·benchmark + idio noise + idio jumps)
 * and peers (= 1·benchmark + own idio noise). Every name feels the shared
 * market-wide jump at `marketIdx`. Returns per-name returns for the breadth filter.
 */
function buildUniverse(
  n: number,
  idioIdx: number[],
  marketIdx: number,
  peers = 25,
): { dates: string[]; ticker: DailyClose[]; bench: DailyClose[]; universeReturns: { date: string; ret: number }[][] } {
  const dates = isoSeq(n);
  const bench: DailyClose[] = [];
  const ticker: DailyClose[] = [];
  const idioSet = new Set(idioIdx);
  const benchRets: number[] = [0];
  let bp = 100;
  let tp = 100;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const benchRet = 0.004 * Math.sin(i * 1.1) + (i === marketIdx ? 0.06 : 0);
      benchRets[i] = benchRet;
      const idio = 0.003 * Math.sin(i * 1.9) + (idioSet.has(i) ? 0.08 : 0);
      bp *= Math.exp(benchRet);
      tp *= Math.exp(benchRet + idio);
    }
    bench.push({ date: dates[i]!, close: bp });
    ticker.push({ date: dates[i]!, close: tp });
  }
  const seriesFor = (phase: number): { date: string; ret: number }[] =>
    dates.slice(1).map((date, k) => ({ date, ret: benchRets[k + 1]! + 0.003 * Math.sin((k + 1) * phase) }));
  const subjectReturns = dates.slice(1).map((date, k) => {
    const i = k + 1;
    return { date, ret: benchRets[i]! + 0.003 * Math.sin(i * 1.9) + (idioSet.has(i) ? 0.08 : 0) };
  });
  const universeReturns = [subjectReturns, ...Array.from({ length: peers }, (_, p) => seriesFor(1.3 + p * 0.11))];
  return { dates, ticker, bench, universeReturns };
}

describe('detectIdiosyncraticEvents', () => {
  it('finds idiosyncratic moves and excludes the market-wide day', () => {
    const { dates, ticker, bench, universeReturns } = buildUniverse(400, [91, 182, 273, 364], 200);
    const marketWide = computeMarketWideDates(universeReturns, 3, 0.5);
    expect(marketWide.has(dates[200]!)).toBe(true);
    const events = detectIdiosyncraticEvents(ticker, bench, marketWide);
    expect(events.map((e) => e.date)).toEqual([91, 182, 273, 364].map((i) => dates[i]!));
    expect(events.map((e) => e.date)).not.toContain(dates[200]!);
    for (const e of events) {
      expect(e.movePct).toBeGreaterThan(0.07); // total move stored
      expect(e.residualZ).toBeGreaterThan(3.5);
    }
  });

  it('residual detection shrinks a market-wide day well below an idiosyncratic one', () => {
    const { dates, ticker, bench } = buildUniverse(400, [91, 182, 273, 364], 200);
    const events = detectIdiosyncraticEvents(ticker, bench);
    const marketDay = events.find((e) => e.date === dates[200]!);
    const idioDay = events.find((e) => e.date === dates[91]!)!;
    if (marketDay) expect(marketDay.residualZ).toBeLessThan(idioDay.residualZ / 2);
  });

  it('honours an explicit market-wide-date exclusion set', () => {
    const { dates, ticker, bench } = buildUniverse(400, [91, 182, 273, 364], 200);
    const events = detectIdiosyncraticEvents(ticker, bench, new Set([dates[182]!]));
    expect(events.map((e) => e.date)).not.toContain(dates[182]!);
    expect(events.map((e) => e.date)).toContain(dates[91]!);
  });

  it('rejects a large residual with a near-zero raw move (benchmark artifact)', () => {
    const dates = isoSeq(300);
    const bench: DailyClose[] = [];
    const ticker: DailyClose[] = [];
    let bp = 100;
    let tp = 100;
    for (let i = 0; i < 300; i++) {
      if (i > 0) {
        const br = 0.004 * Math.sin(i * 1.1) + (i === 150 ? 0.08 : 0);
        bp *= Math.exp(br);
        tp *= Math.exp(i === 150 ? 0 : br + 0.003 * Math.sin(i * 1.9)); // flat on the gap day
      }
      bench.push({ date: dates[i]!, close: bp });
      ticker.push({ date: dates[i]!, close: tp });
    }
    expect(detectIdiosyncraticEvents(ticker, bench).find((e) => e.date === dates[150]!)).toBeUndefined();
  });

  it('returns nothing without enough history', () => {
    expect(detectIdiosyncraticEvents([{ date: '2024-01-01', close: 100 }], [{ date: '2024-01-01', close: 100 }])).toEqual([]);
  });
});

describe('computeMarketWideDates', () => {
  it('flags a date when a share of tickers move sharply together', () => {
    const dates = isoSeq(5);
    const series = Array.from({ length: 25 }, () =>
      dates.slice(1).map((date, i) => ({ date, ret: i === 2 ? 0.07 : 0.002 * (i % 2 ? 1 : -1) })),
    );
    const wide = computeMarketWideDates(series, 3, 0.5);
    expect(wide.has(dates[3]!)).toBe(true);
    expect(wide.has(dates[1]!)).toBe(false);
  });

  it('does not flag when too few tickers observed', () => {
    const dates = isoSeq(5);
    const series = Array.from({ length: 5 }, () => dates.slice(1).map((date, i) => ({ date, ret: i === 2 ? 0.07 : 0.001 })));
    expect(computeMarketWideDates(series, 3, 0.5, 20).size).toBe(0);
  });
});
