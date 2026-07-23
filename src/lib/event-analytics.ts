/**
 * Bridge from a raw option chain to the pure event-variance decomposition:
 * build one {@link ExpiryQuote} per expiry (ATM IV, trading days to expiry, ATM
 * OI, ATM quote width) and run {@link computeImpliedEventMove} against a catalyst
 * date. Kept separate from the pure math so event-variance.ts has no chain deps.
 */
import type { EventGauge, EventSource, RawContract, ReportTiming } from '@/types';
import { normalizeIv } from './chain-analytics';
import { richCheapGauge, type GaugeEvent } from './earnings';
import {
  computeImpliedEventMove,
  DEFAULT_LIQUIDITY_FLOOR,
  type EventVarianceResult,
  type ExpiryQuote,
  type LiquidityFloor,
} from './event-variance';
import { tradingDaysBetween } from './trading-calendar';

const DAY_MS = 86_400_000;

/**
 * OCC expirations (and stored event dates) are CALENDAR DATES encoded at
 * midnight UTC. Passing that instant through the ET wall-clock conversion maps
 * it to 19:00/20:00 ET of the PREVIOUS day, silently costing one trading day
 * (a next-day expiry counted 0 and was dropped mid-session). Anchoring at noon
 * UTC (07:00/08:00 ET year-round) keeps the intended calendar day under both
 * EST and EDT. Applies ONLY to date-encoded values — real instants (`now`,
 * EDGAR acceptance timestamps) must NOT be shifted.
 */
const asCalendarDate = (midnightUtcMs: number): Date => new Date(midnightUtcMs + DAY_MS / 2);

interface ExpiryGroup {
  expiration: number;
  contracts: RawContract[];
}

function groupByExpiry(contracts: RawContract[], now: number): ExpiryGroup[] {
  const map = new Map<number, RawContract[]>();
  for (const c of contracts) {
    // Pre-filter only strictly-past dates (noon-anchored); the real gate is the
    // tradingDays >= 1 check in buildExpiryQuotes.
    if (asCalendarDate(c.expiration).getTime() - now < 0) continue;
    const list = map.get(c.expiration) ?? [];
    list.push(c);
    map.set(c.expiration, list);
  }
  return [...map.entries()]
    .map(([expiration, list]) => ({ expiration, contracts: list }))
    .sort((a, b) => a.expiration - b.expiration);
}

/** Strike nearest spot among contracts carrying a usable IV. */
function atmStrike(contracts: RawContract[], spot: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (normalizeIv(c.iv) <= 0) continue;
    const dist = Math.abs(c.strike - spot);
    if (dist < bestDist) {
      bestDist = dist;
      best = c.strike;
    }
  }
  return best;
}

/**
 * One ExpiryQuote per expiry, ready for the decomposition. ATM IV averages the
 * call+put at the strike nearest spot (decimal, annualized); ATM OI sums that
 * strike's call+put OI; quote width averages (ask−bid)/mid over the ATM contracts
 * that quote two-sided (Infinity when none do, so the liquidity floor refuses).
 */
export function buildExpiryQuotes(
  contracts: RawContract[],
  spot: number,
  now = Date.now(),
): ExpiryQuote[] {
  if (spot <= 0) return [];
  const quotes: ExpiryQuote[] = [];
  for (const group of groupByExpiry(contracts, now)) {
    const strike = atmStrike(group.contracts, spot);
    if (strike === null) continue;
    const atm = group.contracts.filter((c) => c.strike === strike);
    const ivs = atm.map((c) => normalizeIv(c.iv)).filter((v) => v > 0);
    if (ivs.length === 0) continue;
    const iv = ivs.reduce((s, v) => s + v, 0) / ivs.length;
    const tradingDays = tradingDaysBetween(new Date(now), asCalendarDate(group.expiration));
    if (tradingDays < 1) continue;
    const atmOpenInterest = atm.reduce((s, c) => s + Math.max(0, c.openInterest), 0);
    const widths: number[] = [];
    for (const c of atm) {
      if (c.bid !== undefined && c.ask !== undefined && c.bid > 0 && c.ask > 0 && c.mid > 0) {
        widths.push((c.ask - c.bid) / c.mid);
      }
    }
    const quoteWidthFrac = widths.length > 0 ? widths.reduce((s, w) => s + w, 0) / widths.length : Infinity;
    quotes.push({
      expiry: new Date(group.expiration).toISOString().slice(0, 10),
      iv,
      tradingDays,
      atmOpenInterest,
      quoteWidthFrac,
    });
  }
  return quotes;
}

/**
 * Implied event move for a chain given a catalyst date. The event's trading-day
 * offset is measured from `now`; a date on/before today yields offset 0 (every
 * expiry spans it → bracket B). Returns null on any refusal, forwarding the reason
 * to `log`.
 */
export function computeEventMoveForChain(
  contracts: RawContract[],
  spot: number,
  eventDate: Date,
  now = new Date(),
  floor: LiquidityFloor = DEFAULT_LIQUIDITY_FLOOR,
  log?: (reason: string) => void,
): EventVarianceResult | null {
  const quotes = buildExpiryQuotes(contracts, spot, now.getTime());
  const offset = tradingDaysBetween(now, eventDate);
  return computeImpliedEventMove(quotes, offset, floor, log);
}

/**
 * Everything the engine needs to build a ticker's {@link EventGauge} each cycle:
 * the active catalyst date + timing (populated from the DB by the periodic job)
 * and the historical realized-move distribution. The live implied move is
 * recomputed from the chain here so it stays fresh between DB refreshes.
 */
export interface EventGaugeInput {
  eventDate: string | null;
  eventSource: EventSource | null;
  reportTiming: ReportTiming | null;
  events: GaugeEvent[];
  requiredCount: number;
  floor: LiquidityFloor;
}

/** Combine the live chain (implied move) with the stored distribution (rich/cheap). */
export function buildEventGauge(
  input: EventGaugeInput,
  contracts: RawContract[],
  spot: number,
  now = new Date(),
): EventGauge {
  let impliedMove: number | null = null;
  let impliedMethod: 'pre-event-reference' | 'two-post-event' | null = null;
  let diffusiveVol: number | null = null;
  let refusedReason: string | null = null;
  if (input.eventDate) {
    let reason: string | null = null;
    const res = computeEventMoveForChain(
      contracts,
      spot,
      new Date(`${input.eventDate}T12:00:00Z`), // calendar date → noon anchor (see asCalendarDate)
      now,
      input.floor,
      (r) => {
        reason = r;
      },
    );
    if (res) {
      impliedMove = res.impliedMove;
      impliedMethod = res.method;
      diffusiveVol = res.diffusiveVol;
    } else {
      refusedReason = reason;
    }
  }
  const g = richCheapGauge(impliedMove, input.events, input.requiredCount);
  return {
    eventDate: input.eventDate,
    eventSource: input.eventSource,
    reportTiming: input.reportTiming,
    impliedMove,
    impliedMethod,
    diffusiveVol,
    refusedReason,
    display: g.display,
    confirmedCount: g.confirmedCount,
    requiredCount: g.requiredCount,
    medianRealized: g.medianRealized,
    percentile: g.percentile,
    richCheapRatio: g.richCheapRatio,
  };
}
