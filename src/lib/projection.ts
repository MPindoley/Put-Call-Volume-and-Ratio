/**
 * Market-implied price projection from one option chain — no forecast, no
 * fitted model: the probability distribution the options market is pricing.
 *
 * Per expiration:
 *   1. Forward price F from put-call parity at the strikes where call ≈ put
 *      (F = K + (C − P)·e^{rT}); it carries dividends and carry, so the
 *      distribution is centred where the market centres it.
 *   2. The volatility smile: implied vol of the out-of-the-money option at
 *      each strike, against log-moneyness k = ln(K/F), smoothed with a
 *      vega-weighted quadratic (convex) fit.
 *   3. P(price at expiry > K) = N(d2) − φ(d2)·√T·dσ/dk, the digital-option
 *      price with the smile's slope included (Breeden–Litzenberger in its
 *      first-derivative form). The slope term is what makes this skew-aware:
 *      expensive downside puts fatten the left tail instead of being averaged
 *      away into one volatility number.
 *   4. Quantiles of that distribution give the 68% and 95% ranges and the
 *      median; the same curve answers "chance of finishing above $X".
 *
 * These are RISK-NEUTRAL probabilities: they include what traders pay for
 * protection, so they tend to overstate how far a stock really moves. The
 * history check (projection-history.ts) measures that gap per stock and
 * sector, and every logged projection is graded when its expiry passes.
 *
 * Positioning from open interest: the largest call/put OI strikes and the
 * naive dealer-gamma flip level (where Σ ±gamma·OI changes sign).
 *
 * Pure — the engine calls computeProjection once per chain refresh.
 */
import type { RawContract } from '@/types';
import { normalizeIv } from './chain-analytics';

const DAY_MS = 86_400_000;
/** Options stop trading at the 16:00 ET close; ≈20:00 UTC (EDT), close enough for T. */
const EXPIRY_CLOSE_OFFSET_MS = 20 * 3_600_000;

/** Distribution levels reported: 95% range, 68% range, median. */
export const PROJECTION_QUANTILES = [0.025, 0.16, 0.5, 0.84, 0.975] as const;
/** Bump when the method changes, so logged projections never mix methods. */
export const PROJECTION_METHOD_VERSION = 'p1';
/** Target horizons (calendar days) to show: the nearest expiry plus the one closest to each. */
const TARGET_DAYS = [7, 30, 60, 90, 180] as const;
const MAX_EXPIRIES = 6;
const GRID_POINTS = 41;
/** The grid spans ±4 ATM standard deviations of log price. */
const GRID_SIGMAS = 4;
/** Smile points beyond ±3 ATM standard deviations are stale-quote wings; not fitted. */
const FIT_SIGMAS = 3;
const MIN_SMILE_POINTS = 5;

export function riskFreeRate(env: Record<string, string | undefined> = process.env): number {
  const r = Number(env.RISK_FREE_RATE ?? 0.04);
  return Number.isFinite(r) ? r : 0.04;
}

export interface ExpiryProjection {
  /** YYYY-MM-DD. */
  expiration: string;
  /** Calendar days from the data time to the expiry close. */
  dte: number;
  /** Put-call-parity forward (falls back to spot). */
  forward: number;
  /** At-the-money implied volatility, vol points. */
  atmIv: number;
  /** One standard deviation of the log price by expiry (ATM IV × √T), as a fraction. */
  sigmaMove: number;
  /** Price at each PROJECTION_QUANTILES level. */
  quantiles: number[];
  /**
   * Risk-neutral P(price at expiry > level) on an ascending grid of levels, as
   * parallel number arrays (packed doubles: ~20× smaller in memory than an
   * array of small objects, for ~1,400 names × 6 expiries).
   */
  grid: Grid;
  /** 'smile' = skew-aware; 'flat' = one ATM volatility (too few quotes for a smile). */
  method: 'smile' | 'flat';
  /** Out-of-the-money quotes the smile was fitted to. */
  quotes: number;
}

export interface Grid {
  price: number[];
  probAbove: number[];
}

export interface Positioning {
  /** Strike with the most call open interest (expiries ≤ 60 days, within ±25% of spot). */
  callWall: number | null;
  /** Strike with the most put open interest (same window). */
  putWall: number | null;
  /** Price where naive dealer gamma changes sign (nearest crossing to spot), if any in ±20%. */
  gammaFlip: number | null;
  /** Sign of naive dealer gamma at the current price. */
  gammaAtSpot: 'positive' | 'negative' | null;
}

export interface Projection {
  symbol: string;
  spot: number;
  /** Market time the chain reflects (epoch ms). */
  dataAsOf: number;
  method: string;
  expiries: ExpiryProjection[];
  positioning: Positioning;
}

// ── Normal distribution ───────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz & Stegun 7.1.26; |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export function normPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

// ── Smile ─────────────────────────────────────────────────────────────────────

export interface Smile {
  /**
   * σ(k) and dσ/dk. Beyond the quoted range the smile continues in a straight
   * line with its edge slope (no kink), bounded by 0.5×/1.5× the quoted vols.
   * A slope that drops to zero at the last quote would make the tail
   * probability jump there and dump mass into that tail.
   */
  vol(k: number): number;
  slope(k: number): number;
  atm: number;
  method: 'smile' | 'flat';
  points: number;
}

/** Solve a small linear system (Gaussian elimination with partial pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-14) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Weighted least squares for σ = Σ βj·k^j, j < degree+1. */
function fitPoly(pts: { k: number; iv: number; w: number }[], degree: 1 | 2): number[] | null {
  const d = degree + 1;
  const a = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (const p of pts) {
    const pow = [1, p.k, p.k * p.k];
    for (let i = 0; i < d; i++) {
      b[i]! += p.w * pow[i]! * p.iv;
      for (let j = 0; j < d; j++) a[i]![j]! += p.w * pow[i]! * pow[j]!;
    }
  }
  return solve(a, b);
}

/**
 * The smile for one expiry from out-of-the-money quotes (puts below the
 * forward, calls above): ATM vol by interpolation at k = 0, then a
 * vega-weighted convex quadratic (linear if the quadratic bends the wrong way).
 * Too few quotes, or none on one side, → flat at the ATM vol.
 */
export function fitSmile(contracts: RawContract[], forward: number, T: number): Smile | null {
  const raw: { k: number; iv: number }[] = [];
  for (const c of contracts) {
    const iv = normalizeIv(c.iv);
    if (iv < 0.01 || iv > 5 || !(c.mid > 0) || !(c.strike > 0)) continue;
    const otm = c.type === 'put' ? c.strike < forward : c.strike >= forward;
    if (otm) raw.push({ k: Math.log(c.strike / forward), iv });
  }
  if (raw.length === 0) return null;
  raw.sort((x, y) => x.k - y.k);

  // ATM vol: interpolate across k = 0, else the nearest quote.
  const below = [...raw].reverse().find((p) => p.k <= 0);
  const above = raw.find((p) => p.k >= 0);
  let atm: number;
  if (below && above && above.k > below.k) atm = below.iv + ((0 - below.k) / (above.k - below.k)) * (above.iv - below.iv);
  else atm = (below ?? above)!.iv;

  const sd = Math.max(0.02, atm * Math.sqrt(T));
  const pts = raw.filter((p) => Math.abs(p.k) <= FIT_SIGMAS * sd).map((p) => ({ ...p, w: Math.exp(-0.5 * (p.k / sd) ** 2) }));
  const left = pts.filter((p) => p.k < 0).length;
  const right = pts.filter((p) => p.k > 0).length;
  const flat: Smile = { vol: () => atm, slope: () => 0, atm, method: 'flat', points: pts.length };
  if (pts.length < MIN_SMILE_POINTS || left < 2 || right < 2) return flat;

  let beta = fitPoly(pts, 2);
  if (!beta || (beta[2] ?? 0) < 0) beta = fitPoly(pts, 1);
  if (!beta) return flat;
  const [b0 = atm, b1 = 0, b2 = 0] = beta;
  const kMin = pts[0]!.k;
  const kMax = pts[pts.length - 1]!.k;
  const floor = Math.min(...pts.map((p) => p.iv)) * 0.5;
  const cap = Math.max(...pts.map((p) => p.iv)) * 1.5;
  const fitted = (k: number): number => b0 + b1 * k + b2 * k * k;
  const fittedSlope = (k: number): number => b1 + 2 * b2 * k;
  // Inside the quotes: the fit. Outside: the tangent line at the edge.
  const unclamped = (k: number): { v: number; dv: number } =>
    k < kMin
      ? { v: fitted(kMin) + fittedSlope(kMin) * (k - kMin), dv: fittedSlope(kMin) }
      : k > kMax
        ? { v: fitted(kMax) + fittedSlope(kMax) * (k - kMax), dv: fittedSlope(kMax) }
        : { v: fitted(k), dv: fittedSlope(k) };
  return {
    vol: (k) => Math.min(cap, Math.max(floor, unclamped(k).v)),
    slope: (k) => {
      const { v, dv } = unclamped(k);
      return v >= cap || v <= floor ? 0 : dv;
    },
    atm: Math.max(0.01, fitted(0)),
    method: 'smile',
    points: pts.length,
  };
}

// ── Distribution ──────────────────────────────────────────────────────────────

/**
 * Risk-neutral P(S_T > F·e^k) with the smile's slope: N(d2) − φ(d2)·√T·σ'(k),
 * clamped to [0, 1].
 */
export function probAbove(k: number, T: number, smile: Smile): number {
  const sigma = smile.vol(k);
  const sd = sigma * Math.sqrt(T);
  const d2 = (-k - (sigma * sigma * T) / 2) / sd;
  const p = normCdf(d2) - normPdf(d2) * Math.sqrt(T) * smile.slope(k);
  return Math.min(1, Math.max(0, p));
}

/** Price at cumulative probability q from an ascending grid (linear in log price). */
export function quantileFromGrid(grid: Grid, q: number): number {
  const { price, probAbove } = grid;
  const n = price.length;
  if (1 - probAbove[0]! >= q) return price[0]!;
  for (let i = 1; i < n; i++) {
    const ca = 1 - probAbove[i - 1]!;
    const cb = 1 - probAbove[i]!;
    if (cb >= q) {
      const f = cb > ca ? (q - ca) / (cb - ca) : 0;
      return Math.exp(Math.log(price[i - 1]!) + f * (Math.log(price[i]!) - Math.log(price[i - 1]!)));
    }
  }
  return price[n - 1]!;
}

/** Interpolated P(price at expiry > level) from a projection grid. */
export function probAboveLevel(e: Pick<ExpiryProjection, 'grid'>, level: number): number {
  const { price, probAbove } = e.grid;
  const n = price.length;
  if (level <= price[0]!) return probAbove[0]!;
  if (level >= price[n - 1]!) return probAbove[n - 1]!;
  for (let i = 1; i < n; i++) {
    if (level <= price[i]!) {
      const f = (Math.log(level) - Math.log(price[i - 1]!)) / (Math.log(price[i]!) - Math.log(price[i - 1]!));
      return probAbove[i - 1]! + f * (probAbove[i]! - probAbove[i - 1]!);
    }
  }
  return probAbove[n - 1]!;
}

/** Forward from put-call parity at the three strikes where call − put is smallest. */
export function parityForward(contracts: RawContract[], spot: number, T: number, r: number): number {
  const byStrike = new Map<number, { call?: number; put?: number }>();
  for (const c of contracts) {
    if (!(c.mid > 0)) continue;
    const slot = byStrike.get(c.strike) ?? {};
    if (c.type === 'call') slot.call = c.mid;
    else slot.put = c.mid;
    byStrike.set(c.strike, slot);
  }
  const est = [...byStrike.entries()]
    .filter(([, s]) => s.call !== undefined && s.put !== undefined)
    .map(([K, s]) => ({ K, diff: (s.call as number) - (s.put as number) }))
    .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
    .slice(0, 3)
    .map((p) => p.K + p.diff * Math.exp(r * T))
    .sort((a, b) => a - b);
  if (est.length === 0) return spot;
  const f = est[Math.floor(est.length / 2)]!;
  // A wildly off forward means bad quotes, not a real carry: keep the spot.
  return f > 0 && Math.abs(f / spot - 1) <= 0.25 ? f : spot;
}

export function projectExpiry(
  contracts: RawContract[],
  expiration: number,
  spot: number,
  dataAsOf: number,
  r = riskFreeRate(),
): ExpiryProjection | null {
  const dte = (expiration + EXPIRY_CLOSE_OFFSET_MS - dataAsOf) / DAY_MS;
  if (dte < 0.5) return null;
  const T = dte / 365;
  const forward = parityForward(contracts, spot, T, r);
  const smile = fitSmile(contracts, forward, T);
  if (!smile || smile.points < 3) return null;

  const sd = smile.atm * Math.sqrt(T);
  const grid: Grid = { price: [], probAbove: [] };
  let running = 1;
  for (let i = 0; i < GRID_POINTS; i++) {
    const k = -GRID_SIGMAS * sd + (2 * GRID_SIGMAS * sd * i) / (GRID_POINTS - 1);
    // A distribution's tail probability can only fall as the level rises.
    running = Math.min(running, probAbove(k, T, smile));
    grid.price.push(round(forward * Math.exp(k), 4));
    grid.probAbove.push(round(running, 5));
  }
  return {
    expiration: new Date(expiration).toISOString().slice(0, 10),
    dte: round(dte, 2),
    forward: round(forward, 4),
    atmIv: round(smile.atm * 100, 2),
    sigmaMove: round(sd, 5),
    quantiles: PROJECTION_QUANTILES.map((q) => round(quantileFromGrid(grid, q), 4)),
    grid,
    method: smile.method,
    quotes: smile.points,
  };
}

/** The nearest expiry plus the one closest to each target horizon, ascending. */
export function pickExpiries(expirations: number[], dataAsOf: number): number[] {
  const live = [...new Set(expirations)]
    .filter((e) => (e + EXPIRY_CLOSE_OFFSET_MS - dataAsOf) / DAY_MS >= 0.5)
    .sort((a, b) => a - b);
  if (live.length === 0) return [];
  const chosen = new Set<number>([live[0]!]);
  for (const target of TARGET_DAYS) {
    let best: number | null = null;
    let bestDist = Infinity;
    for (const e of live) {
      const d = (e - dataAsOf) / DAY_MS;
      if (d < target * 0.5 || d > target * 1.6) continue;
      const dist = Math.abs(d - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    if (best !== null) chosen.add(best);
  }
  return [...chosen].sort((a, b) => a - b).slice(0, MAX_EXPIRIES);
}

/** Black–Scholes gamma per share. */
function bsGamma(S: number, K: number, T: number, sigma: number, r: number): number {
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sd;
  return normPdf(d1) / (S * sd);
}

export function computePositioning(contracts: RawContract[], spot: number, dataAsOf: number, r = riskFreeRate()): Positioning {
  const callOI = new Map<number, number>();
  const putOI = new Map<number, number>();
  const live: { K: number; T: number; iv: number; oi: number; sign: number }[] = [];
  for (const c of contracts) {
    if (!(c.openInterest > 0)) continue;
    const dte = (c.expiration + EXPIRY_CLOSE_OFFSET_MS - dataAsOf) / DAY_MS;
    if (dte < 0.5) continue;
    if (dte <= 60 && c.strike >= spot * 0.75 && c.strike <= spot * 1.25) {
      const m = c.type === 'call' ? callOI : putOI;
      m.set(c.strike, (m.get(c.strike) ?? 0) + c.openInterest);
    }
    const iv = normalizeIv(c.iv);
    // Gamma is concentrated in the near expiries; far-dated contracts barely move the profile.
    if (iv >= 0.01 && iv <= 5 && dte <= 120) live.push({ K: c.strike, T: dte / 365, iv, oi: c.openInterest, sign: c.type === 'call' ? 1 : -1 });
  }
  const argmax = (m: Map<number, number>): number | null => {
    let best: number | null = null;
    let bestOi = 0;
    for (const [k, oi] of m) if (oi > bestOi) [best, bestOi] = [k, oi];
    return best;
  };

  // Naive dealer gamma across a ±20% price grid: Σ ±Γ(S)·OI·100·S²·1%.
  const gexAt = (S: number): number => live.reduce((s, c) => s + c.sign * bsGamma(S, c.K, c.T, c.iv, r) * c.oi * 100 * S * S * 0.01, 0);
  let gammaFlip: number | null = null;
  let gammaAtSpot: Positioning['gammaAtSpot'] = null;
  if (live.length > 0) {
    const atSpot = gexAt(spot);
    gammaAtSpot = atSpot === 0 ? null : atSpot > 0 ? 'positive' : 'negative';
    const levels = Array.from({ length: 33 }, (_, i) => spot * (0.8 + (0.4 * i) / 32));
    const values = levels.map(gexAt);
    let bestDist = Infinity;
    for (let i = 1; i < levels.length; i++) {
      const a = values[i - 1]!;
      const b = values[i]!;
      if (a === 0 || Math.sign(a) === Math.sign(b)) continue;
      const x = levels[i - 1]! + (levels[i]! - levels[i - 1]!) * (a / (a - b));
      if (Math.abs(x - spot) < bestDist) {
        bestDist = Math.abs(x - spot);
        gammaFlip = round(x, 2);
      }
    }
  }
  return { callWall: argmax(callOI), putWall: argmax(putOI), gammaFlip, gammaAtSpot };
}

export function computeProjection(
  symbol: string,
  contracts: RawContract[],
  spot: number,
  dataAsOf: number,
  r = riskFreeRate(),
): Projection | null {
  if (!(spot > 0) || contracts.length === 0) return null;
  const byExpiry = new Map<number, RawContract[]>();
  for (const c of contracts) {
    const list = byExpiry.get(c.expiration) ?? [];
    list.push(c);
    byExpiry.set(c.expiration, list);
  }
  const expiries: ExpiryProjection[] = [];
  for (const e of pickExpiries([...byExpiry.keys()], dataAsOf)) {
    const p = projectExpiry(byExpiry.get(e) ?? [], e, spot, dataAsOf, r);
    if (p) expiries.push(p);
  }
  if (expiries.length === 0) return null;
  return {
    symbol,
    spot,
    dataAsOf,
    method: PROJECTION_METHOD_VERSION,
    expiries,
    positioning: computePositioning(contracts, spot, dataAsOf, r),
  };
}

/**
 * Rescale a price's log-distance from the forward by a history-calibration
 * ratio (realized ÷ implied move size): ratio 0.8 pulls a range 20% closer.
 */
export function calibratedPrice(price: number, forward: number, ratio: number): number {
  return forward * Math.exp(ratio * Math.log(price / forward));
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
