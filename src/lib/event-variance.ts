/**
 * Event (earnings) variance decomposition — the Phase 3 core.
 *
 * A single option expiry's total variance to expiry is modeled as a diffusive
 * (day-to-day) piece plus a one-off *event* jump that contributes its whole
 * variance on the single session the catalyst is realized:
 *
 *     V_i = σ_d² · τ_i  +  v_e · 1{expiry i spans the event}
 *
 * where
 *     V_i  = σ_i² · τ_i           total implied variance to expiry i,
 *     σ_i  = that expiry's ATM implied vol (decimal, annualized),
 *     τ_i  = tradingDays_i / 252  time to expiry in TRADING-day years (guardrail 2 —
 *            calendar days would inflate σ_d² across weekends/holidays where no
 *            diffusion occurs), and
 *     σ_d² = the annualized diffusive variance rate,
 *     v_e  = the event's variance *lump* (NOT scaled by time — it happens once).
 *
 * The implied one-session event move is then  sqrt(v_e), a fraction of spot.
 *
 * Two extraction brackets, chosen by {@link selectBracket}:
 *
 *   A. pre-event-reference — an adjacent expiry that settles BEFORE the event is
 *      clean diffusion, so σ_d² = σ_ref², and the adjacent expiry that spans the
 *      event gives  v_e = (σ_event² − σ_ref²) · τ_event.
 *
 *   B. two-post-event — no clean pre-event expiry exists, so use the two adjacent
 *      expiries that both span the event and solve the 2×2 system:
 *          σ_d² = (σ_near²·τ_near − σ_far²·τ_far) / (τ_near − τ_far),
 *          v_e  =  σ_near²·τ_near − σ_d²·τ_near.
 *
 * GUARDRAIL 1: a non-positive v_e is returned as a rejection with a reason, never
 * clamped to zero. A near expiry priced below its neighbour for non-event reasons
 * (thin quotes, wide spreads, a stale side) produces this regularly; clamping
 * would manufacture a plausible small event move out of a data problem.
 *
 * GUARDRAIL 3: only ADJACENT bracketing expiries are ever paired, and both must
 * clear a configurable liquidity floor (min OI and max quote width). We refuse to
 * compute rather than reach for a distant expiry whose diffusive vol genuinely
 * differs.
 *
 * Everything here is pure and unit-tested against a hand-worked example.
 */

export const TRADING_DAYS_PER_YEAR = 252;

/** ATM snapshot of one expiry, as consumed by the decomposition. */
export interface ExpiryQuote {
  /** Expiration date, ET ISO (YYYY-MM-DD). */
  expiry: string;
  /** ATM implied volatility, decimal annualized (0.60 = 60%). */
  iv: number;
  /** Trading days from the valuation session to this expiry (≥ 1). */
  tradingDays: number;
  /** Total ATM (call+put nearest-strike) open interest — liquidity gate. */
  atmOpenInterest: number;
  /** ATM quote width as a fraction of mid (0.08 = 8% wide) — liquidity gate. */
  quoteWidthFrac: number;
}

/** Configurable per-expiry liquidity floor (guardrail 3). */
export interface LiquidityFloor {
  minOpenInterest: number;
  maxQuoteWidthFrac: number;
}

export const DEFAULT_LIQUIDITY_FLOOR: LiquidityFloor = {
  minOpenInterest: 100,
  maxQuoteWidthFrac: 0.25,
};

export interface EventVarianceResult {
  method: 'pre-event-reference' | 'two-post-event';
  /** Annualized diffusive variance rate σ_d². */
  diffusiveVar: number;
  /** Clean diffusive vol σ_d (decimal annualized). */
  diffusiveVol: number;
  /** Event variance lump v_e. */
  eventVar: number;
  /** Implied one-session event move sqrt(v_e), as a fraction of spot. */
  impliedMove: number;
  /** The event-spanning (near) expiry used. */
  eventExpiry: string;
  /** The reference expiry (pre-event clean, or the farther post-event one). */
  referenceExpiry: string;
}

export type EventVarianceOutcome =
  | { ok: true; result: EventVarianceResult }
  | { ok: false; reason: string };

/** τ in trading-day years. */
export function tauYears(tradingDays: number): number {
  return tradingDays / TRADING_DAYS_PER_YEAR;
}

function pct(iv: number): string {
  return `${(iv * 100).toFixed(1)}%`;
}

/**
 * Bracket A: an adjacent pre-event reference expiry (clean diffusion) plus the
 * adjacent expiry that spans the event.
 */
export function extractPreEventReference(
  reference: ExpiryQuote,
  event: ExpiryQuote,
): EventVarianceOutcome {
  const tauEvent = tauYears(event.tradingDays);
  const diffusiveVar = reference.iv * reference.iv; // σ_d² = clean pre-event IV²
  const eventVar = (event.iv * event.iv - diffusiveVar) * tauEvent;
  if (!(eventVar > 0)) {
    return {
      ok: false,
      reason:
        `negative/zero event variance (v_e=${eventVar.toExponential(3)}): event-expiry ATM IV ${pct(event.iv)} ` +
        `is not above the pre-event reference IV ${pct(reference.iv)} — thin quotes or non-event vol; refusing to clamp to zero`,
    };
  }
  return {
    ok: true,
    result: {
      method: 'pre-event-reference',
      diffusiveVar,
      diffusiveVol: Math.sqrt(diffusiveVar),
      eventVar,
      impliedMove: Math.sqrt(eventVar),
      eventExpiry: event.expiry,
      referenceExpiry: reference.expiry,
    },
  };
}

/**
 * Bracket B: the two adjacent expiries that both span the event. `near` is the
 * shorter-dated one.
 */
export function extractTwoPostEvent(near: ExpiryQuote, far: ExpiryQuote): EventVarianceOutcome {
  const tauNear = tauYears(near.tradingDays);
  const tauFar = tauYears(far.tradingDays);
  if (!(tauFar > tauNear)) {
    return { ok: false, reason: `far expiry (${far.expiry}) is not longer-dated than near (${near.expiry})` };
  }
  const vNear = near.iv * near.iv * tauNear;
  const vFar = far.iv * far.iv * tauFar;
  const diffusiveVar = (vNear - vFar) / (tauNear - tauFar); // σ_d²
  if (!(diffusiveVar > 0)) {
    return {
      ok: false,
      reason: `non-positive diffusive variance rate (σ_d²=${diffusiveVar.toExponential(3)}) from near IV ${pct(near.iv)} / far IV ${pct(far.iv)}`,
    };
  }
  const eventVar = vNear - diffusiveVar * tauNear;
  if (!(eventVar > 0)) {
    return {
      ok: false,
      reason:
        `negative/zero event variance (v_e=${eventVar.toExponential(3)}): near ATM IV ${pct(near.iv)} not sufficiently ` +
        `elevated over far ${pct(far.iv)} — thin quotes or an ordinary term slope; refusing to clamp to zero`,
    };
  }
  return {
    ok: true,
    result: {
      method: 'two-post-event',
      diffusiveVar,
      diffusiveVol: Math.sqrt(diffusiveVar),
      eventVar,
      impliedMove: Math.sqrt(eventVar),
      eventExpiry: near.expiry,
      referenceExpiry: far.expiry,
    },
  };
}

export interface EventBracketSelection {
  method: 'pre-event-reference' | 'two-post-event';
  reference: ExpiryQuote;
  event: ExpiryQuote;
}

function passesFloor(q: ExpiryQuote, floor: LiquidityFloor): boolean {
  return q.atmOpenInterest >= floor.minOpenInterest && q.quoteWidthFrac <= floor.maxQuoteWidthFrac;
}

/**
 * Choose the ADJACENT bracketing expiry pair for an event `eventTradingDayOffset`
 * trading days out (guardrail 3). Prefers bracket A (a pre-event reference exists);
 * otherwise the two nearest post-event expiries (bracket B). Never scans past the
 * adjacent pair — refuses instead.
 */
export function selectBracket(
  expiries: ExpiryQuote[],
  eventTradingDayOffset: number,
  floor: LiquidityFloor = DEFAULT_LIQUIDITY_FLOOR,
): { ok: true; selection: EventBracketSelection } | { ok: false; reason: string } {
  const sorted = [...expiries].sort((a, b) => a.tradingDays - b.tradingDays);
  const before = sorted.filter((q) => q.tradingDays < eventTradingDayOffset);
  const after = sorted.filter((q) => q.tradingDays >= eventTradingDayOffset);
  if (after.length === 0) {
    return { ok: false, reason: 'no expiry settles on or after the event date' };
  }
  const near = after[0]!; // adjacent expiry that first spans the event

  // Bracket A: the adjacent pre-event expiry as clean-diffusion reference.
  const ref = before.length > 0 ? before[before.length - 1]! : undefined;
  if (ref) {
    if (passesFloor(ref, floor) && passesFloor(near, floor)) {
      return { ok: true, selection: { method: 'pre-event-reference', reference: ref, event: near } };
    }
    // A pre-event expiry exists but fails the floor: try bracket B before giving up.
  }

  // Bracket B: the two adjacent post-event expiries.
  if (after.length >= 2) {
    const far = after[1]!;
    if (passesFloor(near, floor) && passesFloor(far, floor)) {
      return { ok: true, selection: { method: 'two-post-event', reference: far, event: near } };
    }
    return {
      ok: false,
      reason: `adjacent bracketing expiries fail the liquidity floor (OI≥${floor.minOpenInterest}, width≤${(floor.maxQuoteWidthFrac * 100).toFixed(0)}%)`,
    };
  }
  return {
    ok: false,
    reason: 'no adjacent bracketing expiry pair clears the liquidity floor (would require a distant expiry — refusing)',
  };
}

/**
 * End-to-end: pick the adjacent bracket and decompose. Returns null on any refusal
 * (no valid pair, failed floor, or a non-positive variance under guardrail 1),
 * calling `log` with the reason so the refusal is auditable instead of silent.
 */
export function computeImpliedEventMove(
  expiries: ExpiryQuote[],
  eventTradingDayOffset: number,
  floor: LiquidityFloor = DEFAULT_LIQUIDITY_FLOOR,
  log?: (reason: string) => void,
): EventVarianceResult | null {
  const sel = selectBracket(expiries, eventTradingDayOffset, floor);
  if (!sel.ok) {
    log?.(sel.reason);
    return null;
  }
  const { method, reference, event } = sel.selection;
  const outcome =
    method === 'pre-event-reference'
      ? extractPreEventReference(reference, event)
      : extractTwoPostEvent(event, reference); // event = near, reference = far
  if (!outcome.ok) {
    log?.(outcome.reason);
    return null;
  }
  return outcome.result;
}
