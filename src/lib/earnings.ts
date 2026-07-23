/**
 * Earnings/catalyst events — realized-move measurement (timing-aware) and the
 * rich/cheap gauge. All pure and unit-tested.
 *
 * Earnings dates come from the calendar, in priority order:
 *   1. 'manual'  — operator-entered ground truth;
 *   2. 'forward' — a term-structure IV bulge identifies the expiry, the operator
 *                  confirms the date, and the realized reaction is recorded as a
 *                  confirmed event going forward.
 * Nothing else. Price-history inference does NOT feed this distribution — it can't
 * separate earnings from product launches / analyst days — and now lives as a
 * standalone idiosyncratic-move feature (see idiosyncratic.ts).
 *
 * The rich/cheap gauge ranks the live implied event move against the realized
 * moves of CONFIRMED events only, and stays suppressed (no number, an "insufficient
 * confirmed history" state) until a ticker has enough of them. That distribution
 * builds itself quarter by quarter from forward-confirmed events.
 */
import { median, percentileRank } from './sector-stats';

/** Confirmed earnings-event provenance. */
export type EventSource = 'manual' | 'forward';
export type ReportTiming = 'bmo' | 'amc' | 'unknown';

export interface RealizedMove {
  movePct: number;
  timingUncertain: boolean;
  /** The session (ET ISO) whose close terminates the measured move. */
  session: string;
}

/**
 * Realized event move for a dated catalyst, measured on the session matching the
 * IMPLIED definition:
 *   - 'bmo' reports before the open → move over prior-close → event-date close;
 *   - 'amc' reports after the close → move over event-date close → next-session close;
 *   - 'unknown' → we cannot pick the session, so we measure the amc convention but
 *     flag it timing-uncertain (the caller excludes it from the rich/cheap statistic).
 * `sessionsAsc` are the trading-session date keys in ascending order; `closeByDate`
 * maps each to its close. Returns null if the required neighbouring session is missing.
 */
export function realizedEventMove(
  eventDate: string,
  timing: ReportTiming,
  closeByDate: Map<string, number>,
  sessionsAsc: string[],
): RealizedMove | null {
  const idx = sessionsAsc.indexOf(eventDate);
  if (idx < 0) return null;
  const logMove = (fromDate: string | undefined, toDate: string | undefined): number | null => {
    if (fromDate === undefined || toDate === undefined) return null;
    const a = closeByDate.get(fromDate);
    const b = closeByDate.get(toDate);
    if (a === undefined || b === undefined || a <= 0 || b <= 0) return null;
    return Math.abs(Math.log(b / a));
  };
  if (timing === 'bmo') {
    const move = logMove(sessionsAsc[idx - 1], eventDate);
    return move === null ? null : { movePct: move, timingUncertain: false, session: eventDate };
  }
  // amc and unknown both measure event-close → next-close; unknown is flagged.
  const next = sessionsAsc[idx + 1];
  const move = logMove(eventDate, next);
  if (move === null) return null;
  return { movePct: move, timingUncertain: timing === 'unknown', session: next! };
}

// ─── Rich/cheap gauge (confirmed events only) ─────────────────────────────────

export interface GaugeEvent {
  source: EventSource;
  /** True for manual ground truth; for forward events, true once the operator confirms. */
  confirmed: boolean;
  realizedMovePct: number | null;
  realizedTimingUncertain: boolean;
}

export interface RichCheapGauge {
  /** Whether enough confirmed history exists to display a rich/cheap read. */
  display: boolean;
  /** Confirmed events with a usable realized move — count toward the threshold. */
  confirmedCount: number;
  requiredCount: number;
  /** Current implied event move as a fraction of spot (echoed for the UI). */
  impliedMove: number | null;
  /** Median realized move of the confirmed set. */
  medianRealized: number | null;
  /** Where the current implied move sits in the confirmed realized distribution (0–100). */
  percentile: number | null;
  /** implied ÷ median realized: >1 rich, <1 cheap. */
  richCheapRatio: number | null;
}

/**
 * Build the rich/cheap gauge from CONFIRMED events only (manual, or forward once
 * confirmed) that carry a usable realized move. Suppressed — no number, an
 * "insufficient confirmed history" state — until `requiredCount` exist; that is the
 * correct outcome, not a failure. The distribution accretes quarter by quarter.
 */
export function richCheapGauge(
  impliedMove: number | null,
  events: GaugeEvent[],
  requiredCount: number,
): RichCheapGauge {
  const confirmed = events.filter(
    (e) => e.confirmed && e.realizedMovePct !== null && !e.realizedTimingUncertain,
  );
  const moves = confirmed.map((e) => e.realizedMovePct!);
  const display = confirmed.length >= requiredCount;
  const medianRealized = display ? median(moves) : null;
  const percentile = display && impliedMove !== null ? percentileRank(impliedMove, moves, requiredCount) : null;
  return {
    display,
    confirmedCount: confirmed.length,
    requiredCount,
    impliedMove,
    medianRealized,
    percentile,
    richCheapRatio:
      impliedMove !== null && medianRealized !== null && medianRealized > 0 ? impliedMove / medianRealized : null,
  };
}
