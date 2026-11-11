/**
 * What happens after a spike alert — graded by time of day. Pure;
 * spike-outcome-jobs.ts does the I/O.
 *
 * THE QUESTION. An alert says a name's option volume is unusual and which way
 * it leans (call-heavy or put-heavy). Does the price then go the way the flow
 * leaned? And does the answer depend on WHEN the spike came — a morning spike
 * may follow through where an afternoon one fades — and on the name or sector?
 *
 * WHAT IS MEASURED. For every alert, the underlying's move over four windows
 * starting at the moment the alert APPEARED (the moment it could be acted on;
 * on a 15-minute-delayed feed that is later than the market moment that set it
 * off, and the stretch in between is deliberately not credited):
 *
 *   m30    — the next 30 minutes
 *   h2     — the next 2 hours
 *   close  — to that session's settled close
 *   next   — to the next session's settled close
 *
 * Intraday prices come from the stored 5-minute snapshots (the nearest one
 * within priceToleranceMin); a window that runs past the bell is not measured.
 * SPY's move over the same window is recorded beside each, and a single name is
 * scored on its move IN EXCESS of SPY — the same yardstick the rest of the
 * learning uses — so a call-heavy spike on a day the whole market rallies gets
 * no credit for the rally. ETFs are scored on their raw move (SPY against
 * itself is always zero) and kept in a pool of their own.
 *
 * WHAT IS LEARNED. For each time of day (morning / midday / afternoon) × lean
 * × window: how often the price moved the spike's way, and by how much on
 * average. A no-skill spike follows through half the time, so every estimate
 * is shrunk toward the level above, starting from 50%:
 *
 *     50% → all names → sector → name
 *
 * with weight n / (n + prior), exactly as the edge book does (learning.ts). A
 * name with two graded spikes reads as its sector; nothing is shown until the
 * all-names cell has minRoot graded spikes. Observations fade with age
 * (halfLifeSessions), and a name that re-alerts repeatedly in one part of one
 * session counts once (its first alert), so one busy morning is one episode.
 */
import type { SpikeFollowThrough } from '@/types';

export const DAY_PARTS = ['morning', 'midday', 'afternoon'] as const;
export type DayPart = (typeof DAY_PARTS)[number];
export const DAY_PART_LABEL: Record<DayPart, string> = {
  morning: 'Morning (9:30–11:00)',
  midday: 'Midday (11:00–2:00)',
  afternoon: 'Afternoon (2:00–close)',
};

export const LEANS = ['calls', 'puts'] as const;
export type Lean = (typeof LEANS)[number];

export const HORIZONS = ['m30', 'h2', 'close', 'next'] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_LABEL: Record<Horizon, string> = { m30: '30 min', h2: '2 hours', close: 'By the close', next: 'Next day' };
const HORIZON_MIN: Partial<Record<Horizon, number>> = { m30: 30, h2: 120 };

export const SPIKE_PARAMS = {
  /** Sessions for an observation's weight to halve. */
  halfLifeSessions: 120,
  /** Prior strength per level, in effective graded spikes. */
  prior: { all: 30, sector: 40, ticker: 40 },
  /** Graded spikes an all-names cell needs before anything is shown for it. */
  minRoot: 20,
  /** A stored price this close to the wanted moment counts as the price then. */
  priceToleranceMin: 10,
  /** A live alert quotes a name's own record from this many graded spikes, else its sector's, else all names'. */
  quoteMin: { ticker: 10, sector: 20 },
} as const;

/**
 * LONE OR SECTOR-WIDE. A spike in one name while its sector is quiet is news
 * about that name; the same spike while a tenth of the sector is spiking is
 * news about the sector. Each alert records how many of its sector's names
 * were spiking when it fired; it is "sector-wide" from BREADTH.minNames names
 * and BREADTH.minShare of the sector, and the two kinds are graded apart.
 */
export const BREADTH = { minNames: 3, minShare: 0.08 } as const;

/** Sector-wide (true) or one name (false), from the count spiking — this one included — and the sector's size. */
export function isCrowd(spiking: number, names: number): boolean {
  return spiking >= BREADTH.minNames && spiking >= Math.ceil(BREADTH.minShare * names);
}

export const BREADTH_KINDS = ['lone', 'crowd'] as const;
export type BreadthKind = (typeof BREADTH_KINDS)[number];

/** Morning to 11:00, midday to 14:00, afternoon after (minutes since the 9:30 open). */
export function dayPartOf(minutesSinceOpen: number): DayPart {
  return minutesSinceOpen < 90 ? 'morning' : minutesSinceOpen < 270 ? 'midday' : 'afternoon';
}

/** Which way the flow leaned. */
export function leanOf(putCallRatio: number): Lean {
  return putCallRatio > 1 ? 'puts' : 'calls';
}

// ─── Grading one alert ───────────────────────────────────────────────────────

export interface PricePoint {
  t: number;
  price: number;
}

/** The price nearest to `at` in a time-sorted series, if one lies within the tolerance. */
export function priceNear(series: readonly PricePoint[], at: number, toleranceMs: number): number | null {
  let lo = 0;
  let hi = series.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t < at) lo = mid + 1;
    else hi = mid;
  }
  let best: PricePoint | null = null;
  for (const p of [series[lo - 1], series[lo]]) {
    if (p && (best === null || Math.abs(p.t - at) < Math.abs(best.t - at))) best = p;
  }
  return best && Math.abs(best.t - at) <= toleranceMs && best.price > 0 ? best.price : null;
}

const pct = (to: number | null | undefined, from: number | null | undefined): number | null =>
  to && from && to > 0 && from > 0 ? (to / from - 1) * 100 : null;

export interface IntradayGrade {
  /** Price when the alert appeared; null when no stored price is near it or it appeared outside the session. */
  priceAt: number | null;
  spyAt: number | null;
  move30m: number | null;
  move2h: number | null;
  spy30m: number | null;
  spy2h: number | null;
}

/**
 * The intraday windows of one alert. `series` and `spy` are the session's
 * stored prices for the name and for SPY, time-sorted. An alert that appeared
 * after the bell has no intraday windows (and no price here: the settled close
 * is its starting price, set when the closes are graded).
 */
export function gradeIntraday(
  createdAt: number,
  openMs: number,
  closeMs: number,
  series: readonly PricePoint[],
  spy: readonly PricePoint[],
  toleranceMin: number = SPIKE_PARAMS.priceToleranceMin,
): IntradayGrade {
  const none: IntradayGrade = { priceAt: null, spyAt: null, move30m: null, move2h: null, spy30m: null, spy2h: null };
  if (createdAt < openMs || createdAt > closeMs) return none;
  const tol = toleranceMin * 60_000;
  const priceAt = priceNear(series, createdAt, tol);
  if (priceAt === null) return none;
  const spyAt = priceNear(spy, createdAt, tol);
  const window = (minutes: number): [number | null, number | null] => {
    const at = createdAt + minutes * 60_000;
    if (at > closeMs) return [null, null];
    return [pct(priceNear(series, at, tol), priceAt), pct(priceNear(spy, at, tol), spyAt)];
  };
  const [move30m, spy30m] = window(HORIZON_MIN.m30!);
  const [move2h, spy2h] = window(HORIZON_MIN.h2!);
  return { priceAt, spyAt, move30m, move2h, spy30m, spy2h };
}

export interface CloseGrade {
  priceAt: number | null;
  spyAt: number | null;
  moveClose: number | null;
  moveNext: number | null;
  spyClose: number | null;
  spyNext: number | null;
}

/**
 * The close-based windows. An alert that appeared after the bell starts from
 * that session's settled close, so only "next day" applies to it.
 */
export function gradeCloses(a: {
  afterBell: boolean;
  priceAt: number | null;
  spyAt: number | null;
  close: number | null;
  nextClose: number | null;
  spyClose: number | null;
  spyNextClose: number | null;
}): CloseGrade {
  if (a.afterBell) {
    return {
      priceAt: a.close,
      spyAt: a.spyClose,
      moveClose: null,
      spyClose: null,
      moveNext: pct(a.nextClose, a.close),
      spyNext: pct(a.spyNextClose, a.spyClose),
    };
  }
  return {
    priceAt: a.priceAt,
    spyAt: a.spyAt,
    moveClose: pct(a.close, a.priceAt),
    spyClose: pct(a.spyClose, a.spyAt),
    moveNext: pct(a.nextClose, a.priceAt),
    spyNext: pct(a.spyNextClose, a.spyAt),
  };
}

// ─── Learning from graded alerts ─────────────────────────────────────────────

/** One graded alert. Moves are % changes; null = that window was not measured. */
export interface SpikeObs {
  symbol: string;
  sector: string;
  isEtf: boolean;
  /** ET session date the alert appeared on. */
  session: string;
  createdAt: number;
  /** Sessions between the alert and the latest session (0 = the latest). */
  age: number;
  part: DayPart;
  lean: Lean;
  move: Record<Horizon, number | null>;
  spy: Record<Horizon, number | null>;
  /** Sector-wide when it fired (true), one name (false), or not recorded (null/absent). */
  crowd?: boolean | null;
}

/** The move in the spike's direction: positive = the price went the way the flow leaned. */
export function followThrough(o: SpikeObs, h: Horizon): number | null {
  const move = o.move[h];
  if (move === null) return null;
  const base = o.isEtf ? 0 : o.spy[h];
  if (base === null) return null;
  return (o.lean === 'calls' ? 1 : -1) * (move - base);
}

/** One per name per session per part of the day per lean: the first alert. */
export function dedupeEpisodes(obs: readonly SpikeObs[]): SpikeObs[] {
  const first = new Map<string, SpikeObs>();
  for (const o of obs) {
    const key = `${o.symbol}|${o.session}|${o.part}|${o.lean}`;
    const prev = first.get(key);
    if (!prev || o.createdAt < prev.createdAt) first.set(key, o);
  }
  return [...first.values()];
}

export interface CellStat {
  /** Graded spikes. */
  n: number;
  /** Their recency-weighted count. */
  nEff: number;
  /** Weighted count that moved the spike's way (an unchanged price counts half). */
  hits: number;
  /** Weighted sum of the move in the spike's direction, %. */
  move: number;
}

export interface SpikeBook {
  cells: Map<string, CellStat>;
  /** Single names only, all times of day together: lone vs sector-wide spikes, keyed `${kind}|${lean}|${horizon}`. */
  breadth: Map<string, CellStat>;
  /** Episodes behind the book. */
  episodes: number;
}

export type BookLevel = 'all' | 'sector' | 'ticker';

const ROOT = (isEtf: boolean): string => (isEtf ? 'etf' : 'all');
const cellKey = (scope: string, part: DayPart, lean: Lean, h: Horizon): string => `${scope}|${part}|${lean}|${h}`;

/** Tally graded alerts (deduped to episodes) at the all-names, sector and name levels. */
export function buildSpikeBook(obs: readonly SpikeObs[], halfLifeSessions: number = SPIKE_PARAMS.halfLifeSessions): SpikeBook {
  const episodes = dedupeEpisodes(obs);
  const cells = new Map<string, CellStat>();
  const breadth = new Map<string, CellStat>();
  const add = (into: Map<string, CellStat>, key: string, w: number, signed: number): void => {
    const c = into.get(key) ?? { n: 0, nEff: 0, hits: 0, move: 0 };
    c.n += 1;
    c.nEff += w;
    c.hits += w * (signed > 0 ? 1 : signed === 0 ? 0.5 : 0);
    c.move += w * signed;
    into.set(key, c);
  };
  for (const o of episodes) {
    const w = Math.pow(0.5, Math.max(0, o.age) / halfLifeSessions);
    for (const h of HORIZONS) {
      const signed = followThrough(o, h);
      if (signed === null) continue;
      add(cells, cellKey(ROOT(o.isEtf), o.part, o.lean, h), w, signed);
      if (!o.isEtf) add(cells, cellKey(`s:${o.sector}`, o.part, o.lean, h), w, signed);
      add(cells, cellKey(`t:${o.symbol}`, o.part, o.lean, h), w, signed);
      if (!o.isEtf && o.crowd !== null && o.crowd !== undefined)
        add(breadth, `${o.crowd ? 'crowd' : 'lone'}|${o.lean}|${h}`, w, signed);
    }
  }
  return { cells, breadth, episodes: episodes.length };
}

export interface BreadthRowView {
  kind: BreadthKind;
  lean: Lean;
  n: number;
  cells: Record<Horizon, SpikeCellView>;
}

/**
 * Follow-through of lone against sector-wide spikes (single names, every time
 * of day together), each shrunk from a coin flip; a cell shows nothing below
 * minRoot graded spikes.
 */
export function breadthTable(
  book: SpikeBook,
  params: { prior: { all: number }; minRoot: number } = SPIKE_PARAMS,
): BreadthRowView[] {
  const rows: BreadthRowView[] = [];
  for (const kind of BREADTH_KINDS) {
    for (const lean of LEANS) {
      const cells = {} as Record<Horizon, SpikeCellView>;
      let n = 0;
      for (const h of HORIZONS) {
        const c = book.breadth.get(`${kind}|${lean}|${h}`);
        const enough = c !== undefined && c.n >= params.minRoot;
        cells[h] = {
          rate: enough ? (c.hits + params.prior.all * 0.5) / (c.nEff + params.prior.all) : null,
          avgMove: enough ? c.move / (c.nEff + params.prior.all) : null,
          n: c?.n ?? 0,
        };
        n = Math.max(n, c?.n ?? 0);
      }
      rows.push({ kind, lean, n, cells });
    }
  }
  return rows;
}

export interface SpikeTarget {
  symbol?: string;
  sector?: string;
  isEtf: boolean;
}

export interface SpikeEstimate {
  /** Learned chance the price moves the spike's way (0–1), shrunk toward the level above. */
  rate: number;
  /** Learned average move in the spike's direction, %, shrunk the same way. */
  avgMove: number;
  /** Graded spikes at this level. */
  n: number;
}

/**
 * The learned follow-through for one cell at one level, or null while the
 * all-names cell is still below minRoot. ETFs have no sector level (theirs is
 * the ETF pool itself).
 */
export function estimate(
  book: SpikeBook,
  target: SpikeTarget,
  level: BookLevel,
  part: DayPart,
  lean: Lean,
  h: Horizon,
  params: { prior: { all: number; sector: number; ticker: number }; minRoot: number } = SPIKE_PARAMS,
): SpikeEstimate | null {
  const root = book.cells.get(cellKey(ROOT(target.isEtf), part, lean, h));
  if (!root || root.n < params.minRoot) return null;
  let rate = (root.hits + params.prior.all * 0.5) / (root.nEff + params.prior.all);
  let avgMove = root.move / (root.nEff + params.prior.all);
  let n = root.n;
  const step = (key: string, k: number): void => {
    const c = book.cells.get(key);
    rate = ((c?.hits ?? 0) + k * rate) / ((c?.nEff ?? 0) + k);
    avgMove = ((c?.move ?? 0) + k * avgMove) / ((c?.nEff ?? 0) + k);
    n = c?.n ?? 0;
  };
  if (level === 'all') return { rate, avgMove, n };
  if (!target.isEtf) step(cellKey(`s:${target.sector ?? ''}`, part, lean, h), params.prior.sector);
  if (level === 'sector') return { rate, avgMove, n };
  step(cellKey(`t:${target.symbol ?? ''}`, part, lean, h), params.prior.ticker);
  return { rate, avgMove, n };
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface SpikeCellView {
  rate: number | null;
  avgMove: number | null;
  n: number;
}

export interface SpikeRowView {
  part: DayPart;
  lean: Lean;
  /** Graded spikes of this kind at this level (the most any window has). */
  n: number;
  cells: Record<Horizon, SpikeCellView>;
}

export interface SpikeTable {
  level: BookLevel;
  rows: SpikeRowView[];
  /** Graded spikes at this level across all rows. */
  graded: number;
}

/** The full time-of-day × lean table for one level. */
export function spikeTable(book: SpikeBook, target: SpikeTarget, level: BookLevel): SpikeTable {
  const scope =
    level === 'all' || (level === 'sector' && target.isEtf)
      ? ROOT(target.isEtf)
      : level === 'sector'
        ? `s:${target.sector}`
        : `t:${target.symbol}`;
  const rows: SpikeRowView[] = [];
  for (const part of DAY_PARTS) {
    for (const lean of LEANS) {
      const cells = {} as Record<Horizon, SpikeCellView>;
      let n = 0;
      for (const h of HORIZONS) {
        const own = book.cells.get(cellKey(scope, part, lean, h))?.n ?? 0;
        const e = estimate(book, target, level, part, lean, h);
        cells[h] = { rate: e?.rate ?? null, avgMove: e?.avgMove ?? null, n: own };
        n = Math.max(n, own);
      }
      rows.push({ part, lean, n, cells });
    }
  }
  return { level, rows, graded: rows.reduce((a, r) => a + r.n, 0) };
}

/** What past spikes like a live alert were followed by — attached to the alert when enough are graded. */
export type FollowThroughNote = SpikeFollowThrough;

/**
 * The record to quote on a live alert: the name's own once it has enough
 * graded spikes of this kind, else its sector's, else all names'. Windows that
 * cannot apply any more (the session ends first) are left out.
 */
export function followThroughNote(
  book: SpikeBook,
  target: Required<SpikeTarget>,
  minutesSinceOpen: number,
  lean: Lean,
  closeMin = 390,
  quoteMin: { ticker: number; sector: number } = SPIKE_PARAMS.quoteMin,
): FollowThroughNote | null {
  const afterBell = minutesSinceOpen > closeMin;
  const part = dayPartOf(minutesSinceOpen);
  const anchor: Horizon = afterBell ? 'next' : 'close';
  const count = (scope: string): number => book.cells.get(cellKey(scope, part, lean, anchor))?.n ?? 0;
  const level: BookLevel =
    count(`t:${target.symbol}`) >= quoteMin.ticker
      ? 'ticker'
      : !target.isEtf && count(`s:${target.sector}`) >= quoteMin.sector
        ? 'sector'
        : 'all';
  const at = (h: Horizon): SpikeEstimate | null => estimate(book, target, level, part, lean, h);
  const anchorEstimate = at(anchor);
  if (!anchorEstimate) return null;
  return {
    level,
    part,
    lean,
    n: level === 'all' ? anchorEstimate.n : count(level === 'ticker' ? `t:${target.symbol}` : `s:${target.sector}`),
    m30: !afterBell && minutesSinceOpen + 30 <= closeMin ? (at('m30')?.rate ?? null) : null,
    close: afterBell ? null : anchorEstimate.rate,
    next: at('next')?.rate ?? null,
  };
}
