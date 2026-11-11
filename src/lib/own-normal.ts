/**
 * Each name's own normal. Pure; own-normal-jobs.ts does the I/O.
 *
 * WHY. The put/call-extreme signal (pc_extreme) uses one band for every name:
 * open-interest put/call above 1.3 is "put-heavy", below 0.7 "call-heavy". But
 * names sit at very different levels for structural reasons — a stock that
 * institutions hedge runs above 1.3 every day of the year, a retail favourite
 * below 0.7 — so the fixed band flags the same names constantly and says
 * nothing about them. What is informative is a name leaving ITS OWN usual
 * range.
 *
 * WHAT. Each session's OI put/call is placed among the name's own previous
 * sessions — up to `lookback` of them, at least `minObs` — as a percentile.
 * At or beyond `high` it is unusually put-heavy for that name; at or below
 * `low`, unusually call-heavy. That is a separate signal, pc_own, learned
 * beside pc_extreme rather than replacing it: both are graded the same way, so
 * the record shows which definition carries an edge instead of assuming it.
 *
 * POINT-IN-TIME. The percentile uses previous sessions only and is stored on
 * the day's row when it is pinned (DailyMetric.oiPcPct), so the days on which
 * the signal COULD have fired — its base-rate denominator — can be rebuilt
 * exactly, and past sessions can be filled in from stored open interest
 * without hindsight.
 *
 * The cutoffs were fixed before any result was looked at (the signal grid's
 * discipline, signals.ts) and are stamped into OWN_NORMAL.version.
 */
import type { Direction } from './signals';

export const OWN_NORMAL = {
  /** Previous sessions a day is ranked against, at most. */
  lookback: 120,
  /** …and at least: about two months before a name has a "normal". */
  minObs: 40,
  /** Percentile at or below which a day is unusually call-heavy for the name. */
  low: 0.05,
  /** Percentile at or above which a day is unusually put-heavy for the name. */
  high: 0.95,
  /** Bump when any of the above changes: signals under different cutoffs must not mix. */
  version: 'own1:120/40/p05-p95',
} as const;

/** Mid-rank percentile (0–1) of `value` among `prior`: values below it, plus half of those equal to it. */
export function percentileAmong(prior: readonly number[], value: number): number | null {
  if (prior.length === 0) return null;
  let below = 0;
  let ties = 0;
  for (const p of prior) {
    if (p < value) below += 1;
    else if (p === value) ties += 1;
  }
  return (below + 0.5 * ties) / prior.length;
}

/** A day's OI put/call as a percentile of the name's previous sessions (oldest first); null before it has a normal. */
export function ownPercentile(
  prior: readonly number[],
  value: number | null,
  p: { lookback: number; minObs: number } = OWN_NORMAL,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const window = prior.slice(-p.lookback);
  return window.length < p.minObs ? null : percentileAmong(window, value);
}

/**
 * Which way an own-percentile points: unusually put-heavy positioning reads
 * bearish, unusually call-heavy bullish — the same convention as pc_extreme.
 * Null inside the name's usual range.
 */
export function ownDirection(pct: number | null, p: { low: number; high: number } = OWN_NORMAL): Direction | null {
  if (pct === null) return null;
  return pct >= p.high ? 'bearish' : pct <= p.low ? 'bullish' : null;
}

/** A name's usual OI put/call range, as shown beside the live figure. */
export interface OwnRange {
  /** 5th percentile, median and 95th percentile of its recent sessions. */
  lo: number;
  mid: number;
  hi: number;
  /** Sessions behind it. */
  n: number;
}

export type OwnStanding = 'high' | 'low' | 'normal';

/** Where a live value stands against the name's usual range. */
export function standing(value: number | null | undefined, range: OwnRange | null | undefined): OwnStanding | null {
  if (value === null || value === undefined || !range) return null;
  return value > range.hi ? 'high' : value < range.lo ? 'low' : 'normal';
}
