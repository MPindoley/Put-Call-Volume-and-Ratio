/**
 * Pure statistics for the sector-relative analytics layer. No I/O, no DB —
 * every function here is unit-tested against hand-computed values
 * (sector-stats.test.ts). Keeping the math isolated is what lets the daily
 * job stay a thin orchestration shell.
 */

/** Sample median. Even-length → mean of the two middle values. Empty → null. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? ((v[mid - 1] as number) + (v[mid] as number)) / 2 : (v[mid] as number);
}

export function mean(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Sample standard deviation (n−1 denominator). Needs ≥2 points, else null. */
export function stdev(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
  return Math.sqrt(variance);
}

/**
 * z-score of `value` against a window's mean and sample stdev.
 * Returns null when the window is too short or has zero dispersion (a z-score
 * against a flat window is undefined, not zero).
 */
export function zScore(value: number, window: number[]): number | null {
  const m = mean(window);
  const s = stdev(window);
  if (m === null || s === null || s === 0) return null;
  return (value - m) / s;
}

/**
 * Guarded z-score:
 *  • returns null below `minObs` finalized observations (a z against a handful
 *    of points is noise, not signal);
 *  • floors the stdev denominator at `stdevFloor` so a near-constant window
 *    can't blow the magnitude up to a spurious ±double-digits.
 * This is what the UI/DB use; the raw `zScore` above stays for the unit tests
 * and internal callers that want the unguarded value.
 */
export function zScoreGuarded(
  value: number,
  window: number[],
  minObs: number,
  stdevFloor: number,
): number | null {
  const v = window.filter((x) => Number.isFinite(x));
  if (v.length < minObs) return null;
  const m = mean(v);
  const s = stdev(v);
  if (m === null || s === null) return null;
  const denom = Math.max(s, stdevFloor);
  if (denom <= 0) return null;
  return (value - m) / denom;
}

/** Linear-interpolation quantile (q in [0,1]) of an unsorted array. */
export function quantile(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0] as number;
  const pos = q * (v.length - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const a = v[lo] as number;
  const b = v[Math.min(lo + 1, v.length - 1)] as number;
  return a + frac * (b - a);
}

/**
 * Tukey-style outlier fence on `values`: [Q1 − mult·IQR, Q3 + mult·IQR].
 * Returns null below `minN` points (quartiles are meaningless on tiny samples),
 * so the filter no-ops rather than excluding on noise.
 */
export function iqrBounds(values: number[], mult: number, minN = 4): { lo: number; hi: number } | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < minN) return null;
  const q1 = quantile(v, 0.25);
  const q3 = quantile(v, 0.75);
  if (q1 === null || q3 === null) return null;
  const iqr = q3 - q1;
  return { lo: q1 - mult * iqr, hi: q3 + mult * iqr };
}

/**
 * Ordinary-least-squares slope of y on x = 0..n-1 (a time index). Sign and
 * magnitude describe the trend of an evenly-spaced series. Needs ≥3 points.
 */
/**
 * Ordinary least squares of y on x → { alpha, beta } (intercept, slope). Used to
 * regress a ticker's returns against its benchmark so the idiosyncratic residual
 * can be isolated. Needs ≥3 paired points and nonzero x variance.
 */
export function simpleRegression(x: number[], y: number[]): { alpha: number; beta: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] as number;
    sy += y[i] as number;
  }
  const xMean = sx / n;
  const yMean = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - xMean;
    num += dx * ((y[i] as number) - yMean);
    den += dx * dx;
  }
  if (den === 0) return null;
  const beta = num / den;
  return { alpha: yMean - beta * xMean, beta };
}

export function linregSlope(y: number[]): number | null {
  const pts = y.filter((v) => Number.isFinite(v));
  const n = pts.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = pts.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * ((pts[i] as number) - yMean);
    den += dx * dx;
  }
  return den === 0 ? null : num / den;
}

/**
 * t-statistic of a regression slope — used to decide whether a trend is
 * "statistically nonflat" (Phase 2 divergence). Needs ≥3 points.
 */
export function slopeTStat(y: number[]): number | null {
  const pts = y.filter((v) => Number.isFinite(v));
  const n = pts.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = pts.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    sxx += dx * dx;
    sxy += dx * ((pts[i] as number) - yMean);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;
    sse += ((pts[i] as number) - pred) ** 2;
  }
  if (sse === 0) return slope === 0 ? 0 : Number.POSITIVE_INFINITY;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return se === 0 ? null : slope / se;
}

/**
 * Newey-West (Bartlett-kernel HAC) t-statistic for an OLS slope on x = 0..n-1.
 *
 * Overlapping daily observations are autocorrelated, which deflates the plain
 * OLS standard error and inflates its t. This corrects the slope's SE for
 * serial correlation up to `lag` (default: Newey-West 1994 automatic
 * ⌊4·(n/100)^(2/9)⌋). Use it to sanity-check how many OLS-t screens survive a
 * proper HAC adjustment. Needs ≥3 points.
 */
export function slopeTStatNW(y: number[], lag?: number): number | null {
  const v = y.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = v.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    sxx += dx * dx;
    sxy += dx * (v[i] as number);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  // u_i = xc_i · residual_i (the score contributions to the slope).
  const u: number[] = [];
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const resid = (v[i] as number) - (intercept + slope * i);
    sse += resid * resid;
    u.push((i - xMean) * resid);
  }
  if (sse === 0) return slope === 0 ? 0 : slope > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  const L = Math.max(1, lag ?? Math.floor(4 * (n / 100) ** (2 / 9)));
  let s = u.reduce((a, b) => a + b * b, 0); // gamma_0
  for (let j = 1; j <= L && j < n; j++) {
    let gamma = 0;
    for (let t = j; t < n; t++) gamma += (u[t] as number) * (u[t - j] as number);
    s += 2 * (1 - j / (L + 1)) * gamma; // Bartlett weight
  }
  if (s <= 0) return null;
  const seHac = Math.sqrt(s) / sxx;
  return seHac === 0 ? null : slope / seHac;
}

/**
 * Percentile rank of `value` within `history` (0–100): share of samples
 * strictly below it. Null below `minSamples` so thin windows don't lie.
 */
export function percentileRank(value: number, history: number[], minSamples = 20): number | null {
  const v = history.filter((x) => Number.isFinite(x));
  if (v.length < minSamples) return null;
  const below = v.filter((x) => x < value).length;
  return Math.round((below / v.length) * 100);
}

/** Weighted mean; falls back to null if weights sum to zero. */
export function weightedMean(values: number[], weights: number[]): number | null {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] ?? 0;
    const x = values[i];
    if (!Number.isFinite(x as number) || !Number.isFinite(w) || w <= 0) continue;
    num += (x as number) * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}
