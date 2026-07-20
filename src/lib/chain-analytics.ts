/**
 * Chain analytics: everything derivable from one option chain snapshot.
 *
 *  - 25-delta risk reversal (skew): what people are PAYING, not just trading.
 *  - Term structure: near vs far ATM IV, backwardation flag, event-expiry
 *    bulge detection, ATM-straddle implied move.
 *  - Open interest: put/call OI, top strikes, max pain at the nearest expiry.
 *  - Naive dealer gamma exposure (GEX): calls +, puts −, $ per 1% move.
 *
 * All functions are pure; the engine calls computeChainAnalytics once per
 * ticker per poll cycle (~1ms for a 2,000-contract chain).
 */
import type { ChainAnalytics, RawContract } from '@/types';

const DAY_MS = 86_400_000;

/** Normalize an IV that may arrive as percent (27.5) instead of decimal (0.275). */
export function normalizeIv(iv: number): number {
  if (!Number.isFinite(iv) || iv <= 0) return 0;
  return iv > 3 ? iv / 100 : iv;
}

interface ExpiryGroup {
  expiration: number;
  dte: number;
  contracts: RawContract[];
}

function groupByExpiry(contracts: RawContract[], now: number): ExpiryGroup[] {
  const map = new Map<number, RawContract[]>();
  for (const c of contracts) {
    const list = map.get(c.expiration) ?? [];
    list.push(c);
    map.set(c.expiration, list);
  }
  return [...map.entries()]
    .map(([expiration, list]) => ({
      expiration,
      dte: (expiration - now) / DAY_MS,
      contracts: list,
    }))
    .filter((g) => g.dte >= 0.5)
    .sort((a, b) => a.dte - b.dte);
}

/** ATM IV for one expiry (vol points), averaging call+put at the strike nearest spot. */
function atmIv(group: ExpiryGroup, spot: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of group.contracts) {
    const iv = normalizeIv(c.iv);
    if (iv <= 0) continue;
    const dist = Math.abs(c.strike - spot);
    if (dist < bestDist) {
      bestDist = dist;
      best = c.strike;
    }
  }
  if (best === null) return null;
  const atStrike = group.contracts.filter((c) => c.strike === best && normalizeIv(c.iv) > 0);
  if (atStrike.length === 0) return null;
  const avg = atStrike.reduce((s, c) => s + normalizeIv(c.iv), 0) / atStrike.length;
  return avg * 100;
}

function closestTo<T>(items: T[], target: number, value: (t: T) => number): T | undefined {
  let best: T | undefined;
  let bestDist = Infinity;
  for (const item of items) {
    const dist = Math.abs(value(item) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

/** 25Δ risk reversal (vol pts) on the expiry nearest 30 DTE. */
function riskReversal25(groups: ExpiryGroup[]): number | null {
  const eligible = groups.filter((g) => g.dte >= 5 && g.dte <= 75);
  const group = closestTo(eligible, 30, (g) => g.dte);
  if (!group) return null;
  const calls = group.contracts.filter(
    (c) => c.type === 'call' && normalizeIv(c.iv) > 0 && c.delta > 0.1 && c.delta < 0.45,
  );
  const puts = group.contracts.filter(
    (c) => c.type === 'put' && normalizeIv(c.iv) > 0 && c.delta < -0.1 && c.delta > -0.45,
  );
  const call25 = closestTo(calls, 0.25, (c) => c.delta);
  const put25 = closestTo(puts, -0.25, (c) => c.delta);
  if (!call25 || !put25) return null;
  return (normalizeIv(call25.iv) - normalizeIv(put25.iv)) * 100;
}

/** Max pain: settlement price minimizing total intrinsic payout to option holders. */
function maxPain(group: ExpiryGroup): number | null {
  const strikes = [...new Set(group.contracts.map((c) => c.strike))].sort((a, b) => a - b);
  if (strikes.length < 3) return null;
  let bestStrike: number | null = null;
  let bestPayout = Infinity;
  for (const settle of strikes) {
    let payout = 0;
    for (const c of group.contracts) {
      if (c.openInterest <= 0) continue;
      const intrinsic = c.type === 'call' ? Math.max(0, settle - c.strike) : Math.max(0, c.strike - settle);
      payout += intrinsic * c.openInterest;
    }
    if (payout < bestPayout) {
      bestPayout = payout;
      bestStrike = settle;
    }
  }
  return bestStrike;
}

export function computeChainAnalytics(
  contracts: RawContract[],
  spot: number,
  now = Date.now(),
): ChainAnalytics | null {
  if (contracts.length === 0 || spot <= 0) return null;
  const groups = groupByExpiry(contracts, now);
  if (groups.length === 0) return null;

  // Term structure.
  const nearCandidates = groups.filter((g) => g.dte >= 5 && g.dte <= 45);
  const farCandidates = groups.filter((g) => g.dte >= 60 && g.dte <= 200);
  const near = closestTo(nearCandidates, 30, (g) => g.dte) ?? groups[0];
  const far = closestTo(farCandidates, 90, (g) => g.dte);
  const atmIvNear = near ? atmIv(near, spot) : null;
  const atmIvFar = far ? atmIv(far, spot) : null;
  const termSlope = atmIvNear !== null && atmIvFar !== null ? atmIvFar - atmIvNear : null;

  // Event bulge: an expiry within 60 DTE whose ATM IV pops ≥3 pts over both neighbors.
  let eventExpiry: string | null = null;
  const short = groups.filter((g) => g.dte <= 60);
  for (let i = 1; i < short.length - 1; i++) {
    const here = short[i];
    const prev = short[i - 1];
    const next = short[i + 1];
    if (!here || !prev || !next) continue;
    const ivHere = atmIv(here, spot);
    const ivPrev = atmIv(prev, spot);
    const ivNext = atmIv(next, spot);
    if (ivHere !== null && ivPrev !== null && ivNext !== null && ivHere >= ivPrev + 3 && ivHere >= ivNext + 3) {
      eventExpiry = new Date(here.expiration).toISOString().slice(0, 10);
      break;
    }
  }

  // Implied move: ATM straddle of the nearest expiry with usable quotes.
  let impliedMovePct: number | null = null;
  for (const g of groups) {
    const strike = closestTo(
      [...new Set(g.contracts.map((c) => c.strike))],
      spot,
      (s) => s,
    );
    if (strike === undefined) continue;
    const call = g.contracts.find((c) => c.type === 'call' && c.strike === strike && c.mid > 0);
    const put = g.contracts.find((c) => c.type === 'put' && c.strike === strike && c.mid > 0);
    if (call && put) {
      impliedMovePct = ((call.mid + put.mid) / spot) * 100;
      break;
    }
  }

  // Open interest.
  let putOI = 0;
  let callOI = 0;
  const oiByStrike = new Map<number, { putOI: number; callOI: number }>();
  for (const c of contracts) {
    if (c.openInterest <= 0) continue;
    const slot = oiByStrike.get(c.strike) ?? { putOI: 0, callOI: 0 };
    if (c.type === 'put') {
      putOI += c.openInterest;
      slot.putOI += c.openInterest;
    } else {
      callOI += c.openInterest;
      slot.callOI += c.openInterest;
    }
    oiByStrike.set(c.strike, slot);
  }
  const topStrikes = [...oiByStrike.entries()]
    .map(([strike, oi]) => ({ strike, ...oi }))
    .sort((a, b) => b.putOI + b.callOI - (a.putOI + a.callOI))
    .slice(0, 5)
    .sort((a, b) => a.strike - b.strike);

  // Max pain on the nearest expiry with meaningful OI, within 35 DTE.
  const painGroup = groups.find(
    (g) => g.dte <= 35 && g.contracts.reduce((s, c) => s + c.openInterest, 0) > 100,
  );

  // Naive GEX: Σ gamma·OI·100·spot·(1% of spot), calls positive, puts negative.
  let gex = 0;
  let sawGamma = false;
  for (const c of contracts) {
    if (c.openInterest <= 0 || !Number.isFinite(c.gamma) || c.gamma === 0) continue;
    sawGamma = true;
    const sign = c.type === 'call' ? 1 : -1;
    gex += sign * c.gamma * c.openInterest * 100 * spot * (spot * 0.01);
  }

  // LEAP IV: longest expiry ≥ 270 DTE.
  const leaps = groups.filter((g) => g.dte >= 270);
  const leapGroup = closestTo(leaps, 365, (g) => g.dte);
  const leapIv = leapGroup ? atmIv(leapGroup, spot) : null;

  return {
    rrSkew25: round(riskReversal25(groups), 2),
    atmIvNear: round(atmIvNear, 2),
    atmIvFar: round(atmIvFar, 2),
    termSlope: round(termSlope, 2),
    backwardated: termSlope !== null && termSlope < -0.5,
    eventExpiry,
    impliedMovePct: round(impliedMovePct, 2),
    putOI,
    callOI,
    oiPutCall: callOI > 0 ? round(putOI / callOI, 3) : null,
    maxPain: painGroup ? maxPain(painGroup) : null,
    topStrikes,
    gexPer1Pct: sawGamma ? Math.round(gex) : null,
    leapIv: round(leapIv, 2),
  };
}

function round(n: number | null, digits: number): number | null {
  return n === null || !Number.isFinite(n) ? null : Number(n.toFixed(digits));
}

/** Annualized 20-day realized volatility (vol points) from daily closes. */
export function historicalVol(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null;
  const recent = closes.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (prev && curr && prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
  }
  if (returns.length < window - 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Number((Math.sqrt(variance * 252) * 100).toFixed(2));
}

/** Percentile rank of `value` in `history` (0–100), null under 20 samples. */
export function ivRank(value: number, history: number[]): number | null {
  const valid = history.filter((h) => Number.isFinite(h) && h > 0);
  if (valid.length < 20) return null;
  const below = valid.filter((h) => h < value).length;
  return Math.round((below / valid.length) * 100);
}
