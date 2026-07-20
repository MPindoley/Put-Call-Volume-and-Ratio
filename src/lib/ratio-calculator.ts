/**
 * Put/call ratio math. Deliberately dumb and centralized so the numbers are
 * consistent everywhere they appear (table, big number, chart, heatmap).
 *
 * Convention: ratio = put volume / call volume.
 *   > 1.0  more puts than calls (bearish tilt)
 *   < 1.0  more calls than puts (bullish tilt)
 * Zero call volume with put volume present is capped at RATIO_CAP rather than
 * Infinity so sorting and charting stay sane.
 */
import type { AggregateRatio, SectorRatio, TickerFlow, Sector } from '@/types';

export const RATIO_CAP = 10;

export function putCallRatio(putVolume: number, callVolume: number): number {
  if (callVolume <= 0) return putVolume > 0 ? RATIO_CAP : 1;
  return Math.min(RATIO_CAP, putVolume / callVolume);
}

export function aggregateRatio(
  rows: Iterable<Pick<TickerFlow, 'sessionPutVolume' | 'sessionCallVolume' | 'sector'>>,
  previousRatio: number | null,
  history: { mean: number | null; percentile: number | null },
): AggregateRatio {
  let putVolume = 0;
  let callVolume = 0;
  let equityPut = 0;
  let equityCall = 0;
  let etfPut = 0;
  let etfCall = 0;
  for (const row of rows) {
    putVolume += row.sessionPutVolume;
    callVolume += row.sessionCallVolume;
    if (row.sector === 'ETF') {
      etfPut += row.sessionPutVolume;
      etfCall += row.sessionCallVolume;
    } else {
      equityPut += row.sessionPutVolume;
      equityCall += row.sessionCallVolume;
    }
  }
  const ratio = putCallRatio(putVolume, callVolume);
  return {
    ratio,
    putVolume,
    callVolume,
    // Equity-only P/C reads retail sentiment; ETF/index P/C reads hedging.
    equityRatio: equityCall > 0 ? putCallRatio(equityPut, equityCall) : null,
    etfRatio: etfCall > 0 ? putCallRatio(etfPut, etfCall) : null,
    trend: previousRatio === null ? 0 : ratio - previousRatio,
    percentile: history.percentile,
    vs20DayAvg: history.mean !== null && history.mean > 0 ? ratio / history.mean - 1 : null,
    timestamp: Date.now(),
  };
}

export function sectorRatios(rows: Iterable<TickerFlow>): SectorRatio[] {
  const buckets = new Map<Sector, { put: number; call: number; count: number }>();
  for (const row of rows) {
    const b = buckets.get(row.sector) ?? { put: 0, call: 0, count: 0 };
    b.put += row.sessionPutVolume;
    b.call += row.sessionCallVolume;
    b.count += 1;
    buckets.set(row.sector, b);
  }
  return [...buckets.entries()]
    .map(([sector, b]) => ({
      sector,
      ratio: putCallRatio(b.put, b.call),
      putVolume: b.put,
      callVolume: b.call,
      tickerCount: b.count,
    }))
    .sort((a, b) => b.putVolume + b.callVolume - (a.putVolume + a.callVolume));
}

/** Percentile rank of `value` within `samples` (0–100). */
export function percentileRank(value: number, samples: number[]): number | null {
  if (samples.length < 5) return null;
  const below = samples.filter((s) => s < value).length;
  return Math.round((below / samples.length) * 100);
}
