/**
 * Each name's daily clock — what its option volume normally does through the
 * session, learned from its own history. Pure; intraday-jobs.ts does the I/O.
 *
 * WHY. "Unusual volume" is session volume against what is expected BY THIS
 * TIME OF DAY. One fixed curve for every name (busy open, quiet lunch, busy
 * close) is wrong for most of them: an index ETF with same-day expiries trades
 * differently from a small-cap that wakes up in the afternoon, and every name
 * trades differently on a weekly-expiry day or the session after earnings. A
 * name that normally does 30% of its day in the first half hour is not unusual
 * at 30% by 10:00; one that normally does 8% is.
 *
 * WHAT IS LEARNED. The session is cut into 13 half-hour buckets. For each
 * bucket: the share of the day's volume traded in it, split into puts and
 * calls (so the usual put/call mix at each time of day comes with it). One
 * profile per name per kind of day:
 *
 *   regular  — an ordinary session
 *   expiry   — the last session of the week (weekly options expire)
 *   earnings — the session reacting to the name's earnings report
 *
 * HOW IT IS MEASURED. Stored snapshots carry cumulative day volume at their
 * data time. The cumulative curve is interpolated at each half-hour boundary
 * and differenced. A session only counts when the curve is trustworthy: it
 * runs to the close, no boundary sits in a gap longer than maxGapMin, and the
 * day traded at least minDayVolume contracts.
 *
 * HOW IT STAYS HONEST ON THIN DATA. Profiles are recency-weighted running
 * means, shrunk along a nested chain, each level pulled toward the one above
 * in proportion to its evidence (weight / (weight + prior)):
 *
 *   regular days:   fixed default → all names → sector → name
 *   expiry/earnings: the level's regular shape × the day-type tilt of the
 *                    level above → that level's own expiry/earnings data
 *
 * So a name with three sessions on record mostly reads as its sector, and a
 * name's earnings-day clock — four sessions a year — is its own regular clock
 * bent the way earnings days bend its sector's, until its own evidence says
 * otherwise.
 *
 * WHY RUNNING SUMS. The 5-minute snapshots are thinned after a few days (the
 * database is small), so each session is folded into a per-name running sum
 * while its detail still exists: 26 numbers per name per day type, for good.
 * The price is that a changed method cannot be recomputed from history —
 * CLOCK_METHOD stamps the rows, and a new method starts again.
 */
import { isLastSessionOfWeek, isSessionDate, nextSessionDate } from './trading-calendar';

export const BUCKETS = 13;
export const BUCKET_MIN = 30;
export const SESSION_MIN = BUCKETS * BUCKET_MIN; // 390

export const DAY_TYPES = ['regular', 'expiry', 'earnings'] as const;
export type DayType = (typeof DAY_TYPES)[number];

/** Bump when anything that changes what the stored sums mean changes. */
export const CLOCK_METHOD = 'c1';

export const CLOCK_PARAMS = {
  /** Observations (sessions of that day type) for a session's weight to halve. */
  halfLife: 40,
  /** A half-hour boundary inside a snapshot gap longer than this is not measured. */
  maxGapMin: 75,
  /** Sessions with fewer contracts than this say little about shape. */
  minDayVolume: 200,
  /** Prior strength per level, in sessions (name levels) or name-sessions (pooled levels). */
  prior: { all: 100, sector: 100, stock: 10, type: 8 },
  /** Expected volume is never judged against less than this share of a normal day. */
  minFraction: 0.05,
} as const;

/**
 * The fixed profile used before anything is learned: share of the day's volume
 * per half-hour bucket (U-shape — heavy open and close).
 */
export const DEFAULT_INTRADAY_SHAPE = [0.14, 0.1, 0.08, 0.07, 0.06, 0.06, 0.06, 0.06, 0.07, 0.08, 0.09, 0.1, 0.03] as const;

/** Per bucket, the fraction of the day's total volume traded in it as puts / as calls. Σ(put + call) = 1. */
export interface Shape {
  put: number[];
  call: number[];
}

/** "9:30", "10:00", … — the ET start of a bucket. */
export function bucketLabel(bucket: number): string {
  const m = 9 * 60 + 30 + bucket * BUCKET_MIN;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** Which kind of day an ET session date is for a name (earnings wins over expiry). */
export function dayTypeOf(dateKey: string, earningsSessions?: ReadonlySet<string> | null): DayType {
  if (earningsSessions?.has(dateKey)) return 'earnings';
  return isLastSessionOfWeek(dateKey) ? 'expiry' : 'regular';
}

/**
 * The session(s) on which a name trades its earnings report, given the report's
 * calendar date and timing: before the open (or during the session) → that
 * session; after the close → the next one; unknown → both, since either may be it.
 */
export function reactionSessions(eventDate: string, timing: string): string[] {
  const next = nextSessionDate(eventDate);
  const same = isSessionDate(eventDate) ? eventDate : next;
  if (timing === 'bmo' || timing === 'intraday') return [same];
  if (timing === 'amc') return [next];
  return same === next ? [same] : [same, next];
}

/**
 * Expected share of a normal day's volume traded by `minutes` after the open:
 * the shape's cumulative weight, interpolated inside the current bucket.
 * Floored at the first bucket's share (and minFraction): in the opening
 * minutes a handful of prints against a near-zero expectation would otherwise
 * read as a huge multiple.
 */
export function expectedFraction(shape: readonly number[], minutes: number): number {
  const m = Math.min(SESSION_MIN, Math.max(0, minutes));
  const bucket = Math.min(BUCKETS - 1, Math.floor(m / BUCKET_MIN));
  let cumulative = 0;
  for (let i = 0; i < bucket; i++) cumulative += shape[i] ?? 0;
  cumulative += (shape[bucket] ?? 0) * Math.min(1, (m - bucket * BUCKET_MIN) / BUCKET_MIN);
  return Math.min(1, Math.max(cumulative, shape[0] ?? 0, CLOCK_PARAMS.minFraction));
}

// ─── Measuring one session ───────────────────────────────────────────────────

/** Cumulative session volumes at a data time (epoch ms). */
export interface VolumePoint {
  t: number;
  put: number;
  call: number;
}

export interface BucketVolumes {
  /** Contracts traded in each bucket; null where the data does not reach. */
  put: (number | null)[];
  call: (number | null)[];
  /** Minutes after the open that the measurement runs to (capped at the close). */
  throughMin: number;
  /** The curve reaches the close, so the last bucket holds the rest of the day. */
  complete: boolean;
  /** Longest snapshot gap straddling a half-hour boundary, minutes. */
  worstGapMin: number;
}

/** A feed can carry yesterday's totals for a while after the bell: a drop this early is a reset, not a correction. */
const RESET_WINDOW_MS = 60 * 60_000;
/**
 * Snapshots this long after the close still belong to the session: late
 * prints, the end-of-day capture, an evening catch-up pass. Day volume no
 * longer changes then, so any of them carries the day's totals.
 */
export const AFTER_CLOSE_MS = 6 * 3_600_000;
/** The curve "reaches the close" when its last point is within this of it. */
const CLOSE_SLACK_MS = 5 * 60_000;

/**
 * One session's volume per half-hour bucket, from its cumulative snapshots.
 * Points outside [open, close + AFTER_CLOSE_MS] are ignored. Returns null when no
 * snapshot falls inside the session.
 */
export function bucketVolumes(points: readonly VolumePoint[], openMs: number, closeMin = SESSION_MIN): BucketVolumes | null {
  const closeMs = openMs + closeMin * 60_000;
  const inSession = points.filter((p) => p.t >= openMs && p.t <= closeMs + AFTER_CLOSE_MS).sort((a, b) => a.t - b.t);
  // Cumulative volume only rises. A fall in the first hour means the feed was
  // still showing the previous session — drop what came before it; a fall
  // later is a correction — keep the running high.
  let curve: VolumePoint[] = [];
  for (const p of inSession) {
    const last = curve[curve.length - 1];
    if (last && p.put + p.call < last.put + last.call) {
      if (p.t - openMs <= RESET_WINDOW_MS) curve = [];
      else continue;
    }
    const prev = curve[curve.length - 1];
    curve.push(prev ? { t: p.t, put: Math.max(p.put, prev.put), call: Math.max(p.call, prev.call) } : { ...p });
  }
  if (curve.length === 0) return null;
  const lastPoint = curve[curve.length - 1]!;
  if (curve[0]!.t > openMs) curve.unshift({ t: openMs, put: 0, call: 0 });

  const complete = lastPoint.t >= closeMs - CLOSE_SLACK_MS;
  const throughMs = Math.min(lastPoint.t, closeMs);
  let worstGapMs = 0;
  let j = 0;
  /** Cumulative volumes at T (≤ the last point), by linear interpolation. */
  const at = (T: number, boundary: boolean): { put: number; call: number } => {
    while (j < curve.length - 2 && curve[j + 1]!.t < T) j++;
    const a = curve[j]!;
    const b = curve[Math.min(j + 1, curve.length - 1)]!;
    if (b.t <= a.t || T <= a.t) return { put: a.put, call: a.call };
    if (boundary) worstGapMs = Math.max(worstGapMs, b.t - a.t);
    const f = Math.min(1, (T - a.t) / (b.t - a.t));
    return { put: a.put + (b.put - a.put) * f, call: a.call + (b.call - a.call) * f };
  };

  const put: (number | null)[] = [];
  const call: (number | null)[] = [];
  let prev = { put: 0, call: 0 };
  for (let b = 0; b < BUCKETS; b++) {
    const startMs = openMs + b * BUCKET_MIN * 60_000;
    const endMs = Math.min(startMs + BUCKET_MIN * 60_000, closeMs);
    if (startMs >= throughMs || startMs >= closeMs) {
      put.push(null);
      call.push(null);
      continue;
    }
    // The last bucket of a finished session takes whatever printed after the bell too.
    const lastBucket = endMs >= closeMs;
    const cum =
      lastBucket && complete
        ? { put: lastPoint.put, call: lastPoint.call }
        : at(Math.min(endMs, throughMs), endMs <= throughMs && !lastBucket);
    put.push(Math.max(0, cum.put - prev.put));
    call.push(Math.max(0, cum.call - prev.call));
    prev = cum;
  }
  return {
    put,
    call,
    throughMin: Math.round((throughMs - openMs) / 60_000),
    complete,
    worstGapMin: Math.round(worstGapMs / 60_000),
  };
}

/**
 * A finished regular-length session as a shape (each bucket's put and call
 * volume as a fraction of the day's total), or null when it is not measured
 * well enough to learn from.
 */
export function sessionShape(
  points: readonly VolumePoint[],
  openMs: number,
  params: { maxGapMin: number; minDayVolume: number } = CLOCK_PARAMS,
): Shape | null {
  const v = bucketVolumes(points, openMs);
  if (!v || !v.complete || v.worstGapMin > params.maxGapMin) return null;
  const put = v.put.map((x) => x ?? 0);
  const call = v.call.map((x) => x ?? 0);
  const total = put.reduce((a, b) => a + b, 0) + call.reduce((a, b) => a + b, 0);
  if (total < params.minDayVolume) return null;
  return { put: put.map((x) => x / total), call: call.map((x) => x / total) };
}

// ─── Folding sessions into running sums ──────────────────────────────────────

export interface ProfileSums {
  putSum: number[];
  callSum: number[];
  /** Σ weights: the effective number of sessions behind the sums. */
  weight: number;
  /** Sessions folded in, ever. */
  sessions: number;
}

/** Add one session to a profile: older sessions fade by 0.5^(1/halfLife) per new one. */
export function foldSession(prev: ProfileSums | null, shape: Shape, halfLife: number = CLOCK_PARAMS.halfLife): ProfileSums {
  const decay = prev ? Math.pow(0.5, 1 / halfLife) : 0;
  const ok = prev !== null && prev.putSum.length === BUCKETS && prev.callSum.length === BUCKETS;
  return {
    putSum: shape.put.map((x, i) => (ok ? prev.putSum[i]! * decay : 0) + x),
    callSum: shape.call.map((x, i) => (ok ? prev.callSum[i]! * decay : 0) + x),
    weight: (ok ? prev.weight * decay : 0) + 1,
    sessions: (ok ? prev.sessions : 0) + 1,
  };
}

// ─── Resolving stored sums into each name's clock ────────────────────────────

export interface ProfileRow extends ProfileSums {
  symbol: string;
  dayType: DayType;
}

export interface ResolvedClock {
  shapes: Record<DayType, Shape>;
  /** The name's own evidence per day type. */
  own: Record<DayType, { weight: number; sessions: number }>;
  /** How much of the regular-day clock is the name's own data (0–1); the rest is its sector's. */
  ownShare: number;
}

export interface ClockBook {
  all: Record<DayType, Shape>;
  sectors: Map<string, Record<DayType, Shape>>;
  stocks: Map<string, ResolvedClock>;
  /** Name-sessions behind the all-names regular clock. */
  allWeight: number;
}

const ZERO = (): number[] => new Array<number>(BUCKETS).fill(0);

function normalize(s: Shape): Shape {
  const total = s.put.reduce((a, b) => a + b, 0) + s.call.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { put: DEFAULT_INTRADAY_SHAPE.map((x) => x / 2), call: DEFAULT_INTRADAY_SHAPE.map((x) => x / 2) };
  return { put: s.put.map((x) => x / total), call: s.call.map((x) => x / total) };
}

/** (weight × own mean + k × prior) / (weight + k), bucket by bucket; sums carry weight × mean already. */
function blend(sums: ProfileSums | null, prior: Shape, k: number): Shape {
  const w = sums?.weight ?? 0;
  return normalize({
    put: prior.put.map((p, i) => ((sums?.putSum[i] ?? 0) + k * p) / (w + k)),
    call: prior.call.map((p, i) => ((sums?.callSum[i] ?? 0) + k * p) / (w + k)),
  });
}

/** `base` bent the way `typed` differs from `regular` one level up (ratios capped at 5× either way). */
function tilted(base: Shape, typed: Shape, regular: Shape): Shape {
  const ratio = (a: number, b: number): number => Math.min(5, Math.max(0.2, (a + 1e-6) / (b + 1e-6)));
  return normalize({
    put: base.put.map((x, i) => x * ratio(typed.put[i]!, regular.put[i]!)),
    call: base.call.map((x, i) => x * ratio(typed.call[i]!, regular.call[i]!)),
  });
}

function pool(rows: readonly ProfileRow[]): ProfileSums {
  const out: ProfileSums = { putSum: ZERO(), callSum: ZERO(), weight: 0, sessions: 0 };
  for (const r of rows) {
    if (r.putSum.length !== BUCKETS || r.callSum.length !== BUCKETS) continue;
    for (let i = 0; i < BUCKETS; i++) {
      out.putSum[i]! += r.putSum[i]!;
      out.callSum[i]! += r.callSum[i]!;
    }
    out.weight += r.weight;
    out.sessions += r.sessions;
  }
  return out;
}

const TYPED: readonly Exclude<DayType, 'regular'>[] = ['expiry', 'earnings'];

/** Every name's clock for every kind of day, from the stored sums (see the header for the chain). */
export function resolveClocks(
  rows: readonly ProfileRow[],
  universe: readonly { symbol: string; sector: string }[],
  prior: { all: number; sector: number; stock: number; type: number } = CLOCK_PARAMS.prior,
): ClockBook {
  const fixed: Shape = normalize({ put: [], call: [] });
  const sectorOfSymbol = new Map(universe.map((u) => [u.symbol, u.sector]));
  const byType = (t: DayType, keep: (r: ProfileRow) => boolean): ProfileSums =>
    pool(rows.filter((r) => r.dayType === t && keep(r)));

  const allSums = byType('regular', () => true);
  const all = { regular: blend(allSums, fixed, prior.all) } as Record<DayType, Shape>;
  for (const t of TYPED)
    all[t] = blend(
      byType(t, () => true),
      all.regular,
      prior.all,
    );

  const sectors = new Map<string, Record<DayType, Shape>>();
  for (const sector of new Set(universe.map((u) => u.sector))) {
    const inSector = (r: ProfileRow): boolean => sectorOfSymbol.get(r.symbol) === sector;
    const s = { regular: blend(byType('regular', inSector), all.regular, prior.sector) } as Record<DayType, Shape>;
    for (const t of TYPED) s[t] = blend(byType(t, inSector), tilted(s.regular, all[t], all.regular), prior.sector);
    sectors.set(sector, s);
  }

  const own = new Map<string, Partial<Record<DayType, ProfileRow>>>();
  for (const r of rows) {
    if (r.putSum.length !== BUCKETS || r.callSum.length !== BUCKETS) continue;
    const m = own.get(r.symbol) ?? {};
    m[r.dayType] = r;
    own.set(r.symbol, m);
  }
  const stocks = new Map<string, ResolvedClock>();
  for (const { symbol, sector } of universe) {
    const mine = own.get(symbol) ?? {};
    const sec = sectors.get(sector)!;
    const shapes = { regular: blend(mine.regular ?? null, sec.regular, prior.stock) } as Record<DayType, Shape>;
    for (const t of TYPED) shapes[t] = blend(mine[t] ?? null, tilted(shapes.regular, sec[t], sec.regular), prior.type);
    const evidence = (t: DayType): { weight: number; sessions: number } => ({
      weight: mine[t]?.weight ?? 0,
      sessions: mine[t]?.sessions ?? 0,
    });
    const w = mine.regular?.weight ?? 0;
    stocks.set(symbol, {
      shapes,
      own: { regular: evidence('regular'), expiry: evidence('expiry'), earnings: evidence('earnings') },
      ownShare: w / (w + prior.stock),
    });
  }
  return { all, sectors, stocks, allWeight: allSums.weight };
}

/** A shape's total share per bucket (puts + calls) — what the spike detector reads. */
export function shapeTotals(s: Shape): number[] {
  return s.put.map((p, i) => p + s.call[i]!);
}

/** A shape's put fraction per bucket (puts ÷ puts + calls), null where the bucket is empty. */
export function shapePutShare(s: Shape): (number | null)[] {
  return s.put.map((p, i) => (p + s.call[i]! > 0 ? p / (p + s.call[i]!) : null));
}
