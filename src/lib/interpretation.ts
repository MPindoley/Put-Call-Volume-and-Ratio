/**
 * Phase 2 interpretation layer — pure, unit-tested. Turns raw options metrics
 * into direction-aware, inverse-aware readings WITHOUT mutating the raw data.
 *
 *  • Instrument config: inverse / leverage per symbol.
 *  • IV-direction OI tiebreaker: OI change × IV change → demand / supply /
 *    unwind / short-cover, per side.
 *  • Inverse flip: for inverse products the interpretation (not the data) is
 *    translated into underlying-exposure terms.
 */
import type { OiSignal } from '@/types';
import { tryDb } from './db';

export type { OiSignal, SideFlow } from '@/types';

export interface InstrumentConfig {
  inverse: boolean;
  leverage: number;
}

/**
 * Known inverse / leveraged products. Leverage is informational; `inverse`
 * drives the interpretation flip. (These are ETFs — they get no cohort
 * analytics, but their skew/flow coloring must read in underlying-exposure
 * terms.) Editable via TickerOverride.inverse / .leverage.
 */
export const DEFAULT_INSTRUMENTS: Record<string, InstrumentConfig> = {
  SQQQ: { inverse: true, leverage: 3 },
  TQQQ: { inverse: false, leverage: 3 },
  SOXL: { inverse: false, leverage: 3 },
};

export function defaultInstrument(symbol: string): InstrumentConfig {
  return DEFAULT_INSTRUMENTS[symbol] ?? { inverse: false, leverage: 1 };
}

export async function loadInstrumentConfigs(): Promise<Map<string, InstrumentConfig>> {
  const map = new Map<string, InstrumentConfig>(Object.entries(DEFAULT_INSTRUMENTS).map(([s, c]) => [s, { ...c }]));
  await tryDb('load instrument configs', async (db) => {
    const rows = await db.tickerOverride.findMany({
      where: { OR: [{ inverse: true }, { leverage: { not: 1 } }] },
      select: { symbol: true, inverse: true, leverage: true },
    });
    for (const r of rows) map.set(r.symbol, { inverse: r.inverse, leverage: r.leverage });
  });
  return map;
}

// ─── IV-direction OI tiebreaker ───────────────────────────────────────────────

/** How to read the four OI×IV quadrants (UI copy + intent). */
export const OI_SIGNAL_MEANING: Record<Exclude<OiSignal, null>, string> = {
  demand: 'OI up + IV up — new buyers paying up (buying pressure)',
  supply: 'OI up + IV down — new sellers / call overwriting (supply)',
  unwind: 'OI down + IV down — positions closing, vol bleeding (unwind)',
  'short-cover': 'OI down + IV up — closing buybacks / short cover',
};

/**
 * Classify one side. `deadband` (fraction for OI %, vol points for IV) below
 * which a move counts as flat → no signal, so noise near zero doesn't classify.
 */
export function classifyOiFlow(oiChangePct: number | null, ivChange: number | null, oiDead = 1, ivDead = 0.1): OiSignal {
  if (oiChangePct === null || ivChange === null) return null;
  if (Math.abs(oiChangePct) < oiDead || Math.abs(ivChange) < ivDead) return null;
  const oiUp = oiChangePct > 0;
  const ivUp = ivChange > 0;
  if (oiUp && ivUp) return 'demand';
  if (oiUp && !ivUp) return 'supply';
  if (!oiUp && !ivUp) return 'unwind';
  return 'short-cover';
}

/**
 * Per-side IV change decomposed from the underlying IV30 day-change and the
 * skew day-change: skew = callIV − putIV, so d(callIV) ≈ dIV + dSkew/2 and
 * d(putIV) ≈ dIV − dSkew/2. Keeps us on the free feed (no per-side IV series).
 */
export function sideIvChanges(iv30Change: number | null, skewChange: number | null): { call: number | null; put: number | null } {
  if (iv30Change === null) return { call: null, put: null };
  const half = (skewChange ?? 0) / 2;
  return { call: iv30Change + half, put: iv30Change - half };
}

// ─── Inverse-aware interpretation ─────────────────────────────────────────────

/** Skew sentiment for underlying exposure. Inverse flips call↔put meaning. */
export function skewSentiment(rrSkew25: number | null, inverse: boolean): 'bullish' | 'bearish' | 'neutral' {
  if (rrSkew25 === null) return 'neutral';
  const raw = rrSkew25 > 1 ? 'bullish' : rrSkew25 < -1 ? 'bearish' : 'neutral';
  if (raw === 'neutral' || !inverse) return raw;
  return raw === 'bullish' ? 'bearish' : 'bullish';
}

/** Divergence label translated to underlying exposure (inverse flips it). */
export function interpretDivergence(
  divergenceType: 'distribution' | 'accumulation' | null,
  inverse: boolean,
): 'distribution' | 'accumulation' | null {
  if (!divergenceType || !inverse) return divergenceType;
  return divergenceType === 'distribution' ? 'accumulation' : 'distribution';
}

// ─── Divergence classification ────────────────────────────────────────────────

/**
 * Divergence from a price trend and a skew-z trend (both slope + t-stat).
 * Fires only when BOTH are statistically nonflat (|t| ≥ tStat) and point in
 * OPPOSITE directions:
 *   price up + skew z falling (deteriorating) → distribution warning
 *   price down + skew z rising (improving)   → accumulation warning
 * Reads the z-scored skew relative spread, never the raw level.
 */
export function classifyDivergence(
  price: { slope: number | null; t: number | null },
  skewZ: { slope: number | null; t: number | null },
  tStat: number,
): 'distribution' | 'accumulation' | null {
  if (price.slope === null || price.t === null || skewZ.slope === null || skewZ.t === null) return null;
  if (Math.abs(price.t) < tStat || Math.abs(skewZ.t) < tStat) return null;
  if (Math.sign(price.slope) === Math.sign(skewZ.slope)) return null; // same direction = confirmation, not divergence
  if (price.slope > 0 && skewZ.slope < 0) return 'distribution';
  if (price.slope < 0 && skewZ.slope > 0) return 'accumulation';
  return null;
}
