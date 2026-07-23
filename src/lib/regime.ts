/**
 * Daily regime classification (Phase 4.1). Three BINARY dimensions — vol
 * (contango/backwardation), trend (above/below the 50-day), gamma
 * (positive/negative aggregate dealer gamma) — giving an 8-cell regime space.
 *
 * A third "neutral" bucket is deliberately avoided: it would duplicate what the
 * deadband + persistence already do, and it would blow the space to 27 cells so
 * nothing clears a minimum sample. Instead each dimension is binary, and a
 * configurable deadband + persistence hold the prior state through in-band noise.
 * `neutral` exists only at series INITIALIZATION, before a state is first
 * established.
 *
 * Classification is computed forward-only and each day's result is frozen once
 * finalized (point-in-time integrity): today's state is a pure function of the
 * prior day's state and today's raw value — never a retroactive re-fit. Retuning
 * the deadband/persistence is a versioned change (regimeConfigVersion), the same
 * discipline as a cohort-composition change.
 */

export type Polar = 'pos' | 'neg';
export type RegimeCell = Polar | 'neutral';

export interface HysteresisState {
  state: RegimeCell;
  /** Signed pending-flip streak: >0 building toward 'pos', <0 toward 'neg', 0 = none. */
  streak: number;
}

export const INITIAL_HYSTERESIS: HysteresisState = { state: 'neutral', streak: 0 };

/**
 * Advance one binary dimension by a single day.
 *
 * - A raw value within ±`deadband` of zero is in-band noise: hold the prior state
 *   and clear any pending flip.
 * - A value beyond the band on the side matching the current state confirms it.
 * - A value beyond the band on the OPPOSITE side (or establishing from neutral)
 *   must persist `persistDays` consecutive days before the state flips.
 *
 * `deadband` is in the raw value's own units (the caller scales it per dimension);
 * `persistDays` ≥ 1 (1 = flip immediately, no persistence requirement).
 */
export function nextRegime(
  prev: HysteresisState,
  raw: number,
  deadband: number,
  persistDays: number,
): HysteresisState {
  const side: Polar | null = raw >= deadband ? 'pos' : raw <= -deadband ? 'neg' : null;
  if (side === null) return { state: prev.state, streak: 0 }; // in-band → hold, clear pending
  if (side === prev.state) return { state: prev.state, streak: 0 }; // confirms current state
  // Opposite side, or establishing from neutral: build persistence.
  const sameDir = (side === 'pos' && prev.streak > 0) || (side === 'neg' && prev.streak < 0);
  const mag = sameDir ? Math.abs(prev.streak) + 1 : 1;
  if (mag >= persistDays) return { state: side, streak: 0 };
  return { state: prev.state, streak: side === 'pos' ? mag : -mag };
}

/** Fold {@link nextRegime} over an ordered series from the initial state. */
export function foldRegime(
  values: number[],
  deadband: number,
  persistDays: number,
  initial: HysteresisState = INITIAL_HYSTERESIS,
): HysteresisState[] {
  const out: HysteresisState[] = [];
  let cur = initial;
  for (const v of values) {
    cur = nextRegime(cur, v, deadband, persistDays);
    out.push(cur);
  }
  return out;
}

/** FNV-1a hash of the regime-config knobs → a short version stamp for stored rows. */
export function regimeConfigVersion(cfg: {
  volDeadband: number;
  trendDeadbandPct: number;
  gammaDeadbandFrac: number;
  persistDays: number;
}): string {
  const s = `v1|vol=${cfg.volDeadband}|trend=${cfg.trendDeadbandPct}|gamma=${cfg.gammaDeadbandFrac}|persist=${cfg.persistDays}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Domain label mappings (kept out of the pure core so the matrix/UI share them).
export const VOL_LABEL: Record<Polar, string> = { pos: 'contango', neg: 'backwardation' };
export const TREND_LABEL: Record<Polar, string> = { pos: 'above', neg: 'below' };
export const GAMMA_LABEL: Record<Polar, string> = { pos: 'positive', neg: 'negative' };

export function labelOf(state: RegimeCell, map: Record<Polar, string>): string {
  return state === 'neutral' ? 'neutral' : map[state];
}
