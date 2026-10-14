/**
 * How the market-implied projection (projection.ts) has held up against what
 * actually happened — the bridge from "what options price" to "what this
 * stock does".
 *
 * Calibration: for every past session with a stored IV30 and close, the move
 * over the next h sessions divided by the move IV30 implied for that span:
 *
 *     z = ln(close[t+h] / close[t]) / (IV30[t] · √(days/365))
 *
 * If options priced moves exactly right, z would have a standard deviation
 * of 1, 68% of |z| would fall under 1 and 95% under 1.96. The RMS of z — the
 * "realized ÷ implied" ratio — says how much bigger or smaller real moves have
 * been. Options usually overprice moves (ratio < 1): that gap is the premium
 * traders pay for protection.
 *
 * Windows overlap (a 21-session window starts every session), so the count of
 * observations overstates the evidence; `periods` — distinct start dates ÷ h —
 * is the honest count, and drives how much the stock's own ratio is trusted
 * over its sector's (shrinkage, as in the learning loop).
 *
 * Coverage: logged projections (one per name per week) graded at expiry —
 * how often the outcome landed inside the 68% and 95% ranges, and on which
 * side the misses fell.
 *
 * Pure — the job layer (projection-jobs.ts) feeds it stored rows.
 */
import { calibratedPrice } from './projection';

export const HORIZONS = {
  week: { sessions: 5, calendarDays: 7 },
  month: { sessions: 21, calendarDays: 30 },
} as const;
export type HorizonKey = keyof typeof HORIZONS;

/** Non-overlapping periods at which a stock's own ratio carries half the weight. */
export const CALIBRATION_SHRINK_K = 8;
/** Below this many periods a ratio is not shown as evidence ("warming"). */
export const MIN_PERIODS = 3;

export interface CalibrationStats {
  horizon: HorizonKey;
  /** Overlapping observations. */
  n: number;
  /** Non-overlapping equivalent: distinct start dates ÷ horizon sessions. */
  periods: number;
  /** RMS of standardized moves: realized move size ÷ implied. Null without data. */
  ratio: number | null;
  /** Share of moves inside ±1 and ±1.96 implied standard deviations. */
  inside68: number | null;
  inside95: number | null;
  /** Share of moves below −1 / above +1 implied standard deviations. */
  below: number | null;
  above: number | null;
}

export interface DayPoint {
  /** Index into the shared session list (consecutive sessions differ by 1). */
  session: number;
  close: number;
  iv30: number | null;
}

/** Standardized moves over `horizon` for one stock's daily series. */
export function standardizedMoves(series: readonly DayPoint[], horizon: HorizonKey): { session: number; z: number }[] {
  const { sessions: h, calendarDays } = HORIZONS[horizon];
  const bySession = new Map(series.map((p) => [p.session, p]));
  const out: { session: number; z: number }[] = [];
  for (const p of series) {
    const end = bySession.get(p.session + h);
    if (!end || !(p.close > 0) || !(end.close > 0) || p.iv30 === null || !(p.iv30 > 0)) continue;
    const implied = (p.iv30 / 100) * Math.sqrt(calendarDays / 365);
    out.push({ session: p.session, z: Math.log(end.close / p.close) / implied });
  }
  return out;
}

export function calibrationStats(moves: readonly { session: number; z: number }[], horizon: HorizonKey): CalibrationStats {
  const n = moves.length;
  const periods = Math.floor(new Set(moves.map((m) => m.session)).size / HORIZONS[horizon].sessions);
  if (n === 0) return { horizon, n, periods, ratio: null, inside68: null, inside95: null, below: null, above: null };
  const share = (f: (z: number) => boolean): number => round(moves.filter((m) => f(m.z)).length / n, 4);
  return {
    horizon,
    n,
    periods,
    ratio: round(Math.sqrt(moves.reduce((s, m) => s + m.z * m.z, 0) / n), 4),
    inside68: share((z) => Math.abs(z) <= 1),
    inside95: share((z) => Math.abs(z) <= 1.959964),
    below: share((z) => z < -1),
    above: share((z) => z > 1),
  };
}

export interface CalibrationView {
  ticker: CalibrationStats;
  sector: CalibrationStats;
  /** Realized ÷ implied, shrunk: sector toward 1 (no adjustment), the stock toward its sector. */
  ratio: number;
  /** Share of `ratio` resting on the stock's own history (0–1). */
  tickerWeight: number;
  /** Enough history (sector or stock) for the adjusted range to mean anything. */
  usable: boolean;
}

/**
 * Nested shrinkage, as in the learning loop: with no history the ratio is 1
 * (take the market's range as priced); the sector's evidence moves it, and
 * the stock's own evidence moves it from there — each in proportion
 * periods / (periods + K).
 */
export function calibrationView(ticker: CalibrationStats, sector: CalibrationStats, k = CALIBRATION_SHRINK_K): CalibrationView {
  const ws = sector.ratio === null ? 0 : sector.periods / (sector.periods + k);
  const sectorRatio = 1 + ws * ((sector.ratio ?? 1) - 1);
  const wt = ticker.ratio === null ? 0 : ticker.periods / (ticker.periods + k);
  const ratio = sectorRatio + wt * ((ticker.ratio ?? sectorRatio) - sectorRatio);
  return {
    ticker,
    sector,
    ratio: round(ratio, 4),
    tickerWeight: round(wt, 4),
    usable: ticker.periods >= MIN_PERIODS || sector.periods >= MIN_PERIODS,
  };
}

// ── Coverage of logged projections ────────────────────────────────────────────

export interface LoggedProjection {
  forward: number;
  q025: number;
  q16: number;
  q84: number;
  q975: number;
  calRatio: number | null;
  outcome: number | null;
}

export interface Coverage {
  /** Graded projections. */
  n: number;
  inside68: number | null;
  inside95: number | null;
  /** Misses below the 68% range / above it. */
  below68: number | null;
  above68: number | null;
  /** Same 68% check on the history-adjusted range, over projections that had one. */
  calibratedN: number;
  calibratedInside68: number | null;
}

export function coverage(rows: readonly LoggedProjection[]): Coverage {
  const graded = rows.filter((r) => r.outcome !== null && r.outcome > 0);
  const n = graded.length;
  const share = (f: (r: LoggedProjection & { outcome: number }) => boolean, set = graded): number | null =>
    set.length === 0 ? null : round(set.filter((r) => f(r as LoggedProjection & { outcome: number })).length / set.length, 4);
  const cal = graded.filter((r) => r.calRatio !== null);
  return {
    n,
    inside68: share((r) => r.outcome >= r.q16 && r.outcome <= r.q84),
    inside95: share((r) => r.outcome >= r.q025 && r.outcome <= r.q975),
    below68: share((r) => r.outcome < r.q16),
    above68: share((r) => r.outcome > r.q84),
    calibratedN: cal.length,
    calibratedInside68: share((r) => {
      const lo = calibratedPrice(r.q16, r.forward, r.calRatio as number);
      const hi = calibratedPrice(r.q84, r.forward, r.calRatio as number);
      return r.outcome >= lo && r.outcome <= hi;
    }, cal),
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
