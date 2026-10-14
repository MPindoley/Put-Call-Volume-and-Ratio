/**
 * Short-window flow ("Puts 5m", "Calls 5m", net flow, the windowed P/C) from
 * cumulative day-volume snapshots — timed by the DATA's clock, not the fetch
 * clock.
 *
 * Why: a chain refresh reports cumulative day volume, so the difference between
 * two snapshots is the volume traded BETWEEN THEIR DATA TIMES. With a rotating
 * poller that gap is rarely five minutes — ~2 minutes for a hot name, ~9 for a
 * typical one, longer for a quiet one — and summing whatever arrived in the last
 * five wall-clock minutes made one name's "5m" cover two minutes and another's
 * nine. Here each delta becomes an interval [previous data time, this data
 * time], and the window is the five minutes of DATA ending at the newest
 * snapshot: intervals that straddle its start contribute pro rata (flow assumed
 * even within an interval, the only assumption two snapshots allow). When the
 * newest interval is longer than five minutes the result is that interval's
 * rate, scaled to five minutes; when the history is shorter, the rate over what
 * there is. Either way every name's number means the same thing: contracts per
 * five minutes, measured as close to the latest data as the snapshots allow.
 */

export const FLOW_WINDOW_MS = 5 * 60_000;
/** Below this much measured data a rate is too noisy to show (extrapolation would amplify it). */
export const MIN_COVERAGE_MS = 60_000;
/** Intervals ending earlier than this before the newest data time are dropped. */
export const INTERVAL_HORIZON_MS = 60 * 60_000;

export interface FlowInterval {
  /** Data time of the earlier snapshot (epoch ms). */
  start: number;
  /** Data time of the later snapshot (epoch ms). */
  end: number;
  putVolume: number;
  callVolume: number;
  putPremium: number;
  callPremium: number;
}

export interface WindowFlow {
  /** Per-FLOW_WINDOW_MS rates (contracts / USD). Zero when coverage is insufficient. */
  putVolume: number;
  callVolume: number;
  putPremium: number;
  callPremium: number;
  /** Raw (unscaled) contracts inside the window — the actual measured volume. */
  rawPutVolume: number;
  rawCallVolume: number;
  /** How much data time the measurement actually spans (≤ the window, or the whole newest interval). */
  coveredMs: number;
  /** Data time the window ends at (newest snapshot), or null with no intervals. */
  endAt: number | null;
}

const EMPTY: WindowFlow = {
  putVolume: 0,
  callVolume: 0,
  putPremium: 0,
  callPremium: 0,
  rawPutVolume: 0,
  rawCallVolume: 0,
  coveredMs: 0,
  endAt: null,
};

/**
 * Flow over the `windowMs` of data ending at the newest interval, normalized to
 * a per-window rate. Intervals must be in ascending time order and
 * non-overlapping (as produced by successive snapshots).
 */
export function windowFlow(intervals: readonly FlowInterval[], windowMs = FLOW_WINDOW_MS): WindowFlow {
  const newest = intervals[intervals.length - 1];
  if (!newest) return EMPTY;
  const endAt = newest.end;
  const newestSpan = newest.end - newest.start;

  // The newest interval alone already spans the window: its rate is the best
  // available estimate (we cannot see inside it), so use all of it.
  if (newestSpan >= windowMs) {
    return scaled(newest.putVolume, newest.callVolume, newest.putPremium, newest.callPremium, newestSpan, windowMs, endAt);
  }

  const from = endAt - windowMs;
  let put = 0;
  let call = 0;
  let putPrem = 0;
  let callPrem = 0;
  let covered = 0;
  for (let i = intervals.length - 1; i >= 0; i--) {
    const iv = intervals[i]!;
    const span = iv.end - iv.start;
    if (span <= 0) continue;
    const overlap = Math.min(iv.end, endAt) - Math.max(iv.start, from);
    if (overlap <= 0) break;
    const frac = overlap / span;
    put += iv.putVolume * frac;
    call += iv.callVolume * frac;
    putPrem += iv.putPremium * frac;
    callPrem += iv.callPremium * frac;
    covered += overlap;
  }
  return scaled(put, call, putPrem, callPrem, covered, windowMs, endAt);
}

function scaled(
  put: number,
  call: number,
  putPrem: number,
  callPrem: number,
  coveredMs: number,
  windowMs: number,
  endAt: number,
): WindowFlow {
  if (coveredMs < MIN_COVERAGE_MS) return { ...EMPTY, coveredMs, endAt };
  const k = windowMs / coveredMs;
  return {
    putVolume: Math.round(put * k),
    callVolume: Math.round(call * k),
    putPremium: Math.round(putPrem * k),
    callPremium: Math.round(callPrem * k),
    rawPutVolume: Math.round(put),
    rawCallVolume: Math.round(call),
    coveredMs,
    endAt,
  };
}

/** Drop intervals that ended long before the newest data (bounded memory per ticker). */
export function pruneIntervals(intervals: FlowInterval[], horizonMs = INTERVAL_HORIZON_MS): FlowInterval[] {
  const newest = intervals[intervals.length - 1];
  if (!newest) return intervals;
  const cutoff = newest.end - horizonMs;
  return intervals.filter((iv) => iv.end > cutoff);
}
