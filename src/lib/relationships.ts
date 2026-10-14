/**
 * How a stock's options data moves — with itself, and ahead of its price.
 *
 * Every finalized session becomes a row of eight measurements (FEATURES) plus
 * what the stock did next: its 10-session log return in excess of SPY (the
 * same yardstick the learning loop grades signals on). Three readings:
 *
 *  1. LEADS — for each measurement, the rank correlation (Spearman ρ) between
 *     its value on a day and the stock's excess return over the next 10
 *     sessions, plus the plain-language version: how often the stock beat SPY
 *     when the measurement sat in its top fifth vs its bottom fifth. For this
 *     stock and pooled across its sector. Ten-session windows overlap day to
 *     day, so the t-statistic counts n/10 effective observations, not n.
 *
 *  2. MOVES TOGETHER — rank correlations between the DAILY CHANGES of the
 *     measurements and the same-day excess return: which numbers tend to move
 *     at the same time, in which direction.
 *
 *  3. ANALOGS — the past sessions (this stock and its sector peers) whose
 *     measurements sat closest to today's, and what the stock did over the
 *     next 10 sessions after each, against the base rate of all past sessions.
 *     Distance is the root-mean-square gap in robust standard units over the
 *     measurements both days have, plus a penalty for a different market
 *     regime. One analog per stock per 10-session episode, so one long
 *     stretch cannot fill the list.
 *
 * Exploratory by design: correlations are not causes, overlapping windows
 * flatter significance, and a nearest-neighbour summary is only as good as
 * the history behind it — so every figure carries its sample size, and thin
 * samples are refused rather than shown.
 *
 * Pure — relationship-jobs.ts loads the rows.
 */
import { wilsonInterval } from './signals';

export const FORWARD_SESSIONS = 10;

export const FEATURES = [
  { key: 'skewZ', label: 'Skew vs sector (z)' },
  { key: 'ivZ', label: 'IV vs sector (z)' },
  { key: 'oiPcZ', label: 'OI put/call vs sector (z)' },
  { key: 'ivHvZ', label: 'Vol premium vs sector (z)' },
  { key: 'ivRank', label: 'IV rank' },
  { key: 'termSlope', label: 'Term slope' },
  { key: 'volRatio', label: 'Option volume vs normal' },
  { key: 'mom5', label: '5-day move vs SPY' },
] as const;
export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS = FEATURES.map((f) => f.key) as FeatureKey[];

/** Minimum rows before a correlation is shown (stock / sector pool). */
export const MIN_TICKER_ROWS = 40;
export const MIN_SECTOR_ROWS = 100;
/** Minimum past sessions with known outcomes before analogs are searched. */
export const MIN_ANALOG_POOL = 60;
export const ANALOG_COUNT = 25;
/** Penalty (robust SD units) per market-regime dimension that differs. */
const REGIME_PENALTY = 0.5;
const MIN_SHARED_FEATURES = 4;

export interface DayInput {
  /** Index on the shared session clock (consecutive sessions differ by 1). */
  session: number;
  date: string;
  close: number;
  iv30: number | null;
  hv20?: number | null;
  termSlope: number | null;
  optVolume: number | null;
  skewZ30: number | null;
  ivZ30: number | null;
  oiPcZ30: number | null;
  ivHvZ30: number | null;
}

export interface FeatureRow {
  symbol: string;
  session: number;
  date: string;
  features: Partial<Record<FeatureKey, number>>;
  /** Log return over the next 10 sessions minus SPY's (null until known). */
  fwd: number | null;
  /** Same-day log return minus SPY's. */
  ret1: number | null;
  /** Market regime key (e.g. "pos|neg"), when known. */
  regime: string | null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const quantile = (sorted: number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** One stock's daily inputs → feature rows (point in time: each uses only data up to its day). */
export function buildFeatureRows(
  symbol: string,
  days: readonly DayInput[],
  spy: ReadonlyMap<number, number>,
  regimes: ReadonlyMap<number, string> = new Map(),
): FeatureRow[] {
  const sorted = [...days].sort((a, b) => a.session - b.session);
  const bySession = new Map(sorted.map((d) => [d.session, d]));
  const excess = (from: number, to: number): number | null => {
    const a = bySession.get(from)?.close;
    const b = bySession.get(to)?.close;
    const sa = spy.get(from);
    const sb = spy.get(to);
    return a && b && sa && sb && a > 0 && b > 0 && sa > 0 && sb > 0 ? Math.log(b / a) - Math.log(sb / sa) : null;
  };
  const out: FeatureRow[] = [];
  const ivHistory: number[] = [];
  const volHistory: number[] = [];
  for (const d of sorted) {
    const f: Partial<Record<FeatureKey, number>> = {};
    if (d.skewZ30 !== null) f.skewZ = d.skewZ30;
    if (d.ivZ30 !== null) f.ivZ = d.ivZ30;
    if (d.oiPcZ30 !== null) f.oiPcZ = d.oiPcZ30;
    if (d.ivHvZ30 !== null) f.ivHvZ = d.ivHvZ30;
    if (d.termSlope !== null) f.termSlope = d.termSlope;
    // IV rank: percentile of today's IV30 within the trailing year before it.
    if (d.iv30 !== null && d.iv30 > 0) {
      const window = ivHistory.slice(-252);
      if (window.length >= 20) f.ivRank = (100 * window.filter((v) => v < (d.iv30 as number)).length) / window.length;
      ivHistory.push(d.iv30);
    }
    // Option volume against its trailing 20-session median.
    if (d.optVolume !== null && d.optVolume > 0) {
      const base = median(volHistory.slice(-20));
      if (base !== null && volHistory.slice(-20).length >= 10 && base > 0) f.volRatio = d.optVolume / base;
      volHistory.push(d.optVolume);
    }
    const mom = excess(d.session - 5, d.session);
    if (mom !== null) f.mom5 = mom;
    out.push({
      symbol,
      session: d.session,
      date: d.date,
      features: f,
      fwd: excess(d.session, d.session + FORWARD_SESSIONS),
      ret1: excess(d.session - 1, d.session),
      regime: regimes.get(d.session) ?? null,
    });
  }
  return out;
}

/** Average ranks (ties share their mean rank). */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation; null under 3 pairs or no variation. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const rx = ranks(x.slice(0, n));
  const ry = ranks(y.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** t-statistic of a correlation over `nEff` effective observations. */
export function corrT(rho: number, nEff: number): number | null {
  if (nEff <= 2 || Math.abs(rho) >= 1) return null;
  return rho * Math.sqrt((nEff - 2) / (1 - rho * rho));
}

export interface BucketStats {
  n: number;
  /** Share of sessions after which the stock beat SPY over the next 10. */
  beat: number | null;
  /** Median next-10-session excess return. */
  median: number | null;
}

export interface LeadStats {
  n: number;
  rho: number | null;
  /** Overlap-adjusted t (n/10 effective observations). */
  t: number | null;
  /** |t| ≥ 2 on the overlap-adjusted count. */
  notable: boolean;
  top: BucketStats;
  bottom: BucketStats;
}

export interface LeadRow {
  key: FeatureKey;
  label: string;
  ticker: LeadStats | null;
  sector: LeadStats | null;
}

function bucket(values: number[]): BucketStats {
  return {
    n: values.length,
    beat: values.length ? values.filter((v) => v > 0).length / values.length : null,
    median: median(values),
  };
}

export function leadStats(rows: readonly FeatureRow[], key: FeatureKey, minRows: number): LeadStats | null {
  const pairs = rows
    .filter((r) => r.fwd !== null && r.features[key] !== undefined)
    .map((r) => ({ x: r.features[key] as number, y: r.fwd as number }));
  if (pairs.length < minRows) return null;
  const rho = spearman(
    pairs.map((p) => p.x),
    pairs.map((p) => p.y),
  );
  const t = rho === null ? null : corrT(rho, pairs.length / FORWARD_SESSIONS);
  const byX = [...pairs].sort((a, b) => a.x - b.x);
  const fifth = Math.max(1, Math.floor(byX.length / 5));
  return {
    n: pairs.length,
    rho: rho === null ? null : round(rho, 3),
    t: t === null ? null : round(t, 2),
    notable: t !== null && Math.abs(t) >= 2,
    top: bucket(byX.slice(-fifth).map((p) => p.y)),
    bottom: bucket(byX.slice(0, fifth).map((p) => p.y)),
  };
}

export function leadTable(ticker: readonly FeatureRow[], sector: readonly FeatureRow[]): LeadRow[] {
  return FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    ticker: leadStats(ticker, f.key, MIN_TICKER_ROWS),
    sector: leadStats(sector, f.key, MIN_SECTOR_ROWS),
  }));
}

export interface CoMovement {
  /** FEATURE_KEYS plus 'ret' (the stock's same-day excess return). */
  keys: (FeatureKey | 'ret')[];
  /** rho[i][j] between daily changes of keys[i] and keys[j]; null when too few pairs. */
  rho: (number | null)[][];
  n: number[][];
}

/** Rank correlations between DAILY CHANGES (consecutive sessions only) and the same-day excess return. */
export function coMovement(rows: readonly FeatureRow[], minPairs = 30): CoMovement {
  const sorted = [...rows].sort((a, b) => a.session - b.session);
  const changes: Partial<Record<FeatureKey | 'ret', number>>[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b.session !== a.session + 1) continue;
    const d: Partial<Record<FeatureKey | 'ret', number>> = {};
    for (const k of FEATURE_KEYS) {
      const x = a.features[k];
      const y = b.features[k];
      if (x !== undefined && y !== undefined) d[k] = y - x;
    }
    if (b.ret1 !== null) d.ret = b.ret1;
    changes.push(d);
  }
  const keys: (FeatureKey | 'ret')[] = [...FEATURE_KEYS, 'ret'];
  const rho: (number | null)[][] = [];
  const n: number[][] = [];
  for (const a of keys) {
    const rowRho: (number | null)[] = [];
    const rowN: number[] = [];
    for (const b of keys) {
      const pairs = changes.filter((c) => c[a] !== undefined && c[b] !== undefined);
      rowN.push(pairs.length);
      if (a === b) rowRho.push(pairs.length >= minPairs ? 1 : null);
      else if (pairs.length < minPairs) rowRho.push(null);
      else {
        const r = spearman(
          pairs.map((c) => c[a] as number),
          pairs.map((c) => c[b] as number),
        );
        rowRho.push(r === null ? null : round(r, 3));
      }
    }
    rho.push(rowRho);
    n.push(rowN);
  }
  return { keys, rho, n };
}

export interface Analog {
  symbol: string;
  date: string;
  distance: number;
  fwd: number;
  features: Partial<Record<FeatureKey, number>>;
}

export interface AnalogResult {
  /** The session being matched (the stock's latest finalized day). */
  today: { date: string; features: Partial<Record<FeatureKey, number>>; regime: string | null } | null;
  /** Past sessions with a known outcome that could be compared. */
  pool: number;
  analogs: Analog[];
  summary: {
    n: number;
    beat: number;
    beatCi: { lo: number; hi: number } | null;
    median: number;
    q1: number;
    q3: number;
    /** All comparable past sessions (the "no information" baseline). */
    baseBeat: number;
    baseMedian: number;
    avgDistance: number;
  } | null;
  /** Why there is no summary, when there is none. */
  reason: string | null;
}

/** Robust scale (1.4826 × median absolute deviation), falling back to the SD. */
function robustScale(values: number[]): number | null {
  if (values.length < 5) return null;
  const m = median(values) as number;
  const mad = (median(values.map((v) => Math.abs(v - m))) as number) * 1.4826;
  if (mad > 1e-9) return mad;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return sd > 1e-9 ? sd : null;
}

/**
 * The past sessions nearest today's measurements, and what followed them.
 * `candidates` are this stock's and its sector peers' rows; only rows whose
 * 10-session outcome is known are compared.
 */
export function findAnalogs(today: FeatureRow | null, candidates: readonly FeatureRow[], k = ANALOG_COUNT): AnalogResult {
  const pool = candidates.filter((c) => c.fwd !== null);
  const base: AnalogResult = {
    today: today ? { date: today.date, features: today.features, regime: today.regime } : null,
    pool: pool.length,
    analogs: [],
    summary: null,
    reason: null,
  };
  if (!today) return { ...base, reason: 'No finalized session to match yet.' };
  const shared = FEATURE_KEYS.filter((key) => today.features[key] !== undefined);
  if (shared.length < MIN_SHARED_FEATURES) return { ...base, reason: `Only ${shared.length} of ${FEATURE_KEYS.length} measurements available today.` };
  if (pool.length < MIN_ANALOG_POOL) return { ...base, reason: `${pool.length} past sessions with known outcomes; needs ${MIN_ANALOG_POOL}.` };

  const scale = new Map<FeatureKey, number>();
  for (const key of shared) {
    const s = robustScale(pool.map((c) => c.features[key]).filter((v): v is number => v !== undefined));
    if (s !== null) scale.set(key, s);
  }
  const scored = pool
    .map((c) => {
      let sum = 0;
      let used = 0;
      for (const [key, s] of scale) {
        const v = c.features[key];
        if (v === undefined) continue;
        sum += ((v - (today.features[key] as number)) / s) ** 2;
        used += 1;
      }
      if (used < MIN_SHARED_FEATURES) return null;
      let distance = Math.sqrt(sum / used);
      if (today.regime && c.regime) {
        const [tv, tt] = today.regime.split('|');
        const [cv, ct] = c.regime.split('|');
        distance += (tv !== cv ? REGIME_PENALTY : 0) + (tt !== ct ? REGIME_PENALTY : 0);
      }
      return { c, distance };
    })
    .filter((x): x is { c: FeatureRow; distance: number } => x !== null)
    .sort((a, b) => a.distance - b.distance);

  // One analog per stock per 10-session episode.
  const chosen: { c: FeatureRow; distance: number }[] = [];
  for (const s of scored) {
    if (chosen.length >= k) break;
    if (chosen.some((x) => x.c.symbol === s.c.symbol && Math.abs(x.c.session - s.c.session) < FORWARD_SESSIONS)) continue;
    chosen.push(s);
  }
  if (chosen.length < 10) return { ...base, reason: `Only ${chosen.length} comparable past sessions.` };

  const outcomes = chosen.map((x) => x.c.fwd as number);
  const sortedOut = [...outcomes].sort((a, b) => a - b);
  const all = pool.map((c) => c.fwd as number);
  const beats = outcomes.filter((v) => v > 0).length;
  return {
    ...base,
    analogs: chosen.map((x) => ({
      symbol: x.c.symbol,
      date: x.c.date,
      distance: round(x.distance, 3),
      fwd: round(x.c.fwd as number, 5),
      features: x.c.features,
    })),
    summary: {
      n: chosen.length,
      beat: round(beats / chosen.length, 4),
      beatCi: wilsonInterval(beats, chosen.length),
      median: round(quantile(sortedOut, 0.5), 5),
      q1: round(quantile(sortedOut, 0.25), 5),
      q3: round(quantile(sortedOut, 0.75), 5),
      baseBeat: round(all.filter((v) => v > 0).length / all.length, 4),
      baseMedian: round(median(all) as number, 5),
      avgDistance: round(chosen.reduce((s, x) => s + x.distance, 0) / chosen.length, 3),
    },
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
