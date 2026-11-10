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
  /**
   * `ratio` for the conditions the stock is in as of the latest session
   * (market stress, its own IV level, earnings inside the window). Absent
   * until the job has attached it.
   */
  conditional?: ConditionalRatio | null;
}

/** The ratio to adjust a range with: the conditional one when it exists. */
export function ratioInForce(v: CalibrationView): number {
  return v.conditional?.ratio ?? v.ratio;
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

// ── Conditions: when moves run bigger or smaller than usual ───────────────────

/**
 * The plain ratio is an average over every kind of period. Three things known
 * at the start of a window change how large the move in it tends to be,
 * relative to what was priced:
 *
 *   vol      — the market's volatility regime that day: calm or stressed
 *   iv       — the stock's own IV against its recent median: high or low
 *   earnings — whether the stock reports inside the window
 *
 * For each condition, a FACTOR: realized ÷ implied in that state, over
 * realized ÷ implied across both states (1.15 = moves run 15% bigger than this
 * pool's usual when the state holds). Factors are learned on pools — all names,
 * then each sector, shrunk toward the all-names factor, itself shrunk toward 1
 * — because one stock has far too few independent periods in each state. A
 * stock's ratio for today is its blended ratio × the factors of the states it
 * is in now. The three are treated as independent (a main-effects
 * approximation): the joint cells are much too thin to estimate.
 *
 * Evidence is counted in independent periods of the STATE (its distinct start
 * dates ÷ horizon), so a monthly factor for stressed markets stays near 1
 * until several stressed months have been seen.
 */
export const CONDITIONS = ['vol', 'iv', 'earnings'] as const;
export type Condition = (typeof CONDITIONS)[number];
/** The two states of each condition; index 1 is the one that usually means bigger moves. */
export const CONDITION_STATES = { vol: ['calm', 'stressed'], iv: ['low', 'high'], earnings: ['none', 'inside'] } as const;
export type ConditionState = { vol: 'calm' | 'stressed' | null; iv: 'low' | 'high' | null; earnings: 'none' | 'inside' | null };

/** Independent periods of a state at which its factor carries half the weight. */
export const CONDITION_SHRINK_K = 8;
/** A factor is never taken to move a ratio by more than this either way. */
const FACTOR_BOUNDS: [number, number] = [0.6, 1.8];
/** Prior sessions of IV needed to call a day's IV high or low, and how far back the median looks. */
export const IV_STATE_MIN_OBS = 20;
export const IV_STATE_LOOKBACK = 120;

export interface ConditionedMove {
  session: number;
  z: number;
  state: ConditionState;
}

/** High or low against the median of the stock's own previous IVs (point-in-time); null with too few. */
export function ivState(prior: readonly number[], iv: number | null): 'low' | 'high' | null {
  if (iv === null || !(iv > 0) || prior.length < IV_STATE_MIN_OBS) return null;
  const sorted = [...prior].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return iv > median ? 'high' : 'low';
}

/**
 * Standardized moves with the conditions in force at each window's start.
 * `volBySession` is the market's regime per session; `earningsSessions` the
 * sessions this stock traded an earnings report on.
 */
export function conditionedMoves(
  series: readonly DayPoint[],
  horizon: HorizonKey,
  volBySession: ReadonlyMap<number, 'calm' | 'stressed'>,
  earningsSessions: ReadonlySet<number>,
): ConditionedMove[] {
  const h = HORIZONS[horizon].sessions;
  const ivs: number[] = [];
  const ivAt = new Map<number, 'low' | 'high' | null>();
  for (const p of [...series].sort((a, b) => a.session - b.session)) {
    ivAt.set(p.session, ivState(ivs.slice(-IV_STATE_LOOKBACK), p.iv30));
    if (p.iv30 !== null && p.iv30 > 0) ivs.push(p.iv30);
  }
  return standardizedMoves(series, horizon).map((m) => {
    let inside = false;
    for (let s = m.session + 1; s <= m.session + h && !inside; s++) inside = earningsSessions.has(s);
    return {
      ...m,
      state: { vol: volBySession.get(m.session) ?? null, iv: ivAt.get(m.session) ?? null, earnings: inside ? 'inside' : 'none' },
    };
  });
}

/** Running sums for one pool: per condition and state, Σz², observations and the distinct start sessions. */
export interface ConditionTally {
  sum: Record<Condition, [number, number]>;
  n: Record<Condition, [number, number]>;
  sessions: Record<Condition, [Set<number>, Set<number>]>;
}

export function emptyTally(): ConditionTally {
  const pair = <T>(make: () => T): Record<Condition, [T, T]> => ({
    vol: [make(), make()],
    iv: [make(), make()],
    earnings: [make(), make()],
  });
  return { sum: pair(() => 0), n: pair(() => 0), sessions: pair(() => new Set<number>()) };
}

export function addToTally(t: ConditionTally, moves: readonly ConditionedMove[]): void {
  for (const m of moves) {
    for (const c of CONDITIONS) {
      const state = m.state[c];
      if (state === null) continue;
      const i = (CONDITION_STATES[c] as readonly string[]).indexOf(state);
      t.sum[c][i as 0 | 1] += m.z * m.z;
      t.n[c][i as 0 | 1] += 1;
      t.sessions[c][i as 0 | 1].add(m.session);
    }
  }
}

export interface ConditionFactor {
  /** Realized ÷ implied in this state over the pool's usual, straight from the data; null without data in both states. */
  raw: number | null;
  /** Independent periods of this state behind it. */
  periods: number;
  /** The factor used: raw, shrunk toward the level above. */
  factor: number;
}
export type ConditionFactors = Record<Condition, [ConditionFactor, ConditionFactor]>;

/**
 * A pool's factors, shrunk toward `parent` (the all-names factors for a
 * sector; nothing — i.e. 1 — for all names).
 */
export function conditionFactors(
  t: ConditionTally,
  horizon: HorizonKey,
  parent?: ConditionFactors,
  k = CONDITION_SHRINK_K,
): ConditionFactors {
  const h = HORIZONS[horizon].sessions;
  const out = {} as ConditionFactors;
  for (const c of CONDITIONS) {
    const total = t.n[c][0] + t.n[c][1];
    const overall = total > 0 ? (t.sum[c][0] + t.sum[c][1]) / total : 0;
    out[c] = [0, 1].map((i) => {
      const n = t.n[c][i as 0 | 1];
      const periods = Math.floor(t.sessions[c][i as 0 | 1].size / h);
      const other = t.n[c][(1 - i) as 0 | 1];
      const raw = n > 0 && other > 0 && overall > 0 ? Math.sqrt(t.sum[c][i as 0 | 1] / n / overall) : null;
      const prior = parent?.[c][i as 0 | 1].factor ?? 1;
      const w = raw === null ? 0 : periods / (periods + k);
      const factor = Math.min(FACTOR_BOUNDS[1], Math.max(FACTOR_BOUNDS[0], prior + w * ((raw ?? prior) - prior)));
      return { raw: raw === null ? null : round(raw, 4), periods, factor: round(factor, 4) };
    }) as [ConditionFactor, ConditionFactor];
  }
  return out;
}

export interface ConditionalRatio {
  /** The blended ratio × the factors of the states in force. */
  ratio: number;
  /** The factors applied, one per condition whose state is known. */
  applied: { condition: Condition; state: string; factor: number; periods: number }[];
}

/** A stock's ratio for the conditions it is in now, from its blended ratio and its sector's factors. */
export function conditionalRatio(baseRatio: number, factors: ConditionFactors, state: ConditionState): ConditionalRatio {
  const applied: ConditionalRatio['applied'] = [];
  let ratio = baseRatio;
  for (const c of CONDITIONS) {
    const s = state[c];
    if (s === null) continue;
    const f = factors[c][(CONDITION_STATES[c] as readonly string[]).indexOf(s) as 0 | 1];
    ratio *= f.factor;
    applied.push({ condition: c, state: s, factor: f.factor, periods: f.periods });
  }
  return { ratio: round(ratio, 4), applied };
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
