/**
 * How long a signal takes to play out. Pure; learning-jobs.ts does the I/O.
 *
 * THE QUESTION. The edge book (learning.ts) grades every signal on one window:
 * did the stock beat SPY in the signal's direction over the next 10 sessions,
 * more often than it does with no signal? But some signals work within days
 * and fade, and some need a month. Every graded signal already has its return
 * at 5, 10 and 20 sessions on record, so the same book is rebuilt at each
 * window — same evidence, same shrinkage, same regime-matched base rates, each
 * window with its own base rate — and the three edges are compared.
 *
 * LIKE FOR LIKE. A signal is graded at all three windows together, once its
 * 20-session window has closed, so the three books rest on the same signals:
 * a difference between windows is a difference in timing, not in sample.
 *
 * HONEST ABOUT PICKING. Naming the best of three noisy numbers flatters it, so
 * an edge is only called an edge when it is above minEdge AND above its own
 * standard error; a window is only called best when it clears the others by
 * minGap (or half the standard error, if that is more — the windows share
 * their signals, so they move together and their gap is steadier than either);
 * and nothing is said before minGraded signals are graded. Otherwise the
 * verdict is "steady" (no window stands out) or "none" (no edge at any
 * window).
 *
 * DESCRIPTIVE ONLY. The learned lean shown on the scanner stays on the
 * 10-session window: that is the window self-grading holds it to, and letting
 * each signal choose its own best window would be choosing after the fact.
 */
import { estimateEdge, LEVELS, type EdgeBook, type Level, type SignalKey } from './learning';

export const TIMING_HORIZONS = [5, 10, 20] as const;
export type TimingHorizon = (typeof TIMING_HORIZONS)[number];

export const TIMING_PARAMS = {
  /** An edge smaller than this (hit-rate points above base) is not called an edge. */
  minEdge: 0.02,
  /** Two windows closer than this are not told apart. */
  minGap: 0.015,
  /** Graded signals of this type and direction needed before any verdict. */
  minGraded: 30,
} as const;

/**
 * learning — too few graded signals to say.
 * none     — no edge at any window.
 * fast     — the edge is there early and gone by the longest window.
 * mid      — the 10-session window stands out from both sides.
 * slow     — the edge is weak early and there later.
 * steady   — an edge, and no window stands out.
 * against  — no positive edge anywhere, and a negative one: it has pointed the wrong way.
 */
export type TimingVerdict = 'learning' | 'none' | 'fast' | 'mid' | 'slow' | 'steady' | 'against';

export interface WindowEdge {
  horizon: TimingHorizon;
  /** Shrunk edge at the level asked for: hit-rate points above base. */
  edge: number;
  /** Graded signals at that level in this window's book. */
  n: number;
}

export interface SignalTiming {
  windows: WindowEdge[];
  /** Approximate standard error of those edges (the largest of the three windows'). */
  se: number;
  verdict: TimingVerdict;
  /** The window the verdict points at: strongest for an edge, worst for `against`; null when none stands out. */
  best: TimingHorizon | null;
  /** Graded signals at the level asked for (the fewest any window has): its own evidence, not what it inherits. */
  graded: number;
}

/** A timing with the level it was read at. */
export interface LevelTiming extends SignalTiming {
  level: Level;
}

/**
 * The verdict for three window edges (see TimingVerdict). `se` is the
 * estimates' standard error: the floors rise with it, so a thin sample has to
 * show more before anything is said.
 */
export function classifyTiming(
  e: Record<TimingHorizon, number>,
  graded: number,
  se = 0,
  p: { minEdge: number; minGap: number; minGraded: number } = TIMING_PARAMS,
): { verdict: TimingVerdict; best: TimingHorizon | null } {
  if (graded < p.minGraded) return { verdict: 'learning', best: null };
  const edgeFloor = Math.max(p.minEdge, se);
  const gapFloor = Math.max(p.minGap, se / 2);
  const order = [...TIMING_HORIZONS].sort((a, b) => e[b] - e[a] || a - b); // strongest first; ties → the shorter window
  const top = order[0]!;
  if (e[top] < edgeFloor) {
    const worst = order[order.length - 1]!;
    return e[worst] <= -edgeFloor ? { verdict: 'against', best: worst } : { verdict: 'none', best: null };
  }
  const clears = (a: TimingHorizon, b: TimingHorizon): boolean => e[a] - e[b] >= gapFloor;
  if (top === 5) return clears(5, 20) ? { verdict: 'fast', best: 5 } : { verdict: 'steady', best: null };
  if (top === 20) return clears(20, 5) ? { verdict: 'slow', best: 20 } : { verdict: 'steady', best: null };
  if (clears(10, 5) && clears(10, 20)) return { verdict: 'mid', best: 10 };
  if (clears(10, 5)) return { verdict: 'slow', best: 10 }; // weak in week one, there from week two on
  if (clears(10, 20)) return { verdict: 'fast', best: 10 }; // there by week two, gone by week four
  return { verdict: 'steady', best: null };
}

/**
 * A signal's edge at each window, estimated down to `depth` (signal → regime →
 * sector → ticker). The verdict needs minGraded signals AT that level: a level
 * with few of its own mostly repeats the level above, and its timing would be
 * the level above's timing plus noise.
 */
export function timingAt(books: Record<TimingHorizon, EdgeBook>, key: SignalKey, depth: Level): SignalTiming {
  const at = LEVELS.indexOf(depth);
  const edges = {} as Record<TimingHorizon, number>;
  const windows: WindowEdge[] = [];
  let graded = Infinity;
  let se = 0;
  for (const h of TIMING_HORIZONS) {
    const book = books[h];
    const path = estimateEdge(book, key).path;
    const step = path[at]!;
    edges[h] = step.edge;
    windows.push({ horizon: h, edge: step.edge, n: step.n });
    graded = Math.min(graded, step.n);
    // The edge book's own bound (learning.ts): Bernoulli variance ≤ 0.25 over the
    // evidence-plus-prior of the deepest level, down to `depth`, that has data.
    let info = book.params.prior.signal;
    for (let i = 0; i <= at; i++) if (path[i]!.nEff > 0) info = path[i]!.nEff + book.params.prior[LEVELS[i]!];
    se = Math.max(se, Math.sqrt(0.25 / info));
  }
  if (!Number.isFinite(graded)) graded = 0;
  return { windows, se, ...classifyTiming(edges, graded, se), graded };
}

/**
 * A signal's timing at the most specific level that has enough graded signals
 * of its own to say anything — the stock, else its sector, else the market
 * regime, else all names (where it may still be `learning`).
 */
export function timingDeepest(books: Record<TimingHorizon, EdgeBook>, key: SignalKey): LevelTiming {
  for (let i = LEVELS.length - 1; i > 0; i--) {
    const level = LEVELS[i]!;
    const t = timingAt(books, key, level);
    if (t.verdict !== 'learning') return { ...t, level };
  }
  return { ...timingAt(books, key, 'signal'), level: 'signal' };
}

/** A few words for a table cell. */
export function timingShort(t: Pick<SignalTiming, 'verdict' | 'best'>): string {
  switch (t.verdict) {
    case 'learning':
      return 'learning';
    case 'none':
      return 'no edge yet';
    case 'steady':
      return '1–4 weeks';
    case 'mid':
      return '~2 weeks';
    case 'fast':
      return t.best === 5 ? '~1 week' : 'within 2 weeks';
    case 'slow':
      return t.best === 20 ? '~4 weeks' : '2+ weeks';
    case 'against':
      return 'wrong way';
  }
}

/** One plain sentence. */
export function timingSentence(
  t: Pick<SignalTiming, 'verdict' | 'best' | 'graded'>,
  minGraded: number = TIMING_PARAMS.minGraded,
): string {
  switch (t.verdict) {
    case 'learning':
      return `Still learning its timing: ${t.graded} graded so far, ${minGraded} needed.`;
    case 'none':
      return 'No clear edge at any window yet, so no timing to report.';
    case 'steady':
      return 'Its edge has held about equally from one week out to four — no window stands out.';
    case 'mid':
      return 'It has worked best over about two weeks (10 sessions): weaker in the first week, and weaker again by four.';
    case 'fast':
      return t.best === 5
        ? 'It has worked fast: strongest in the first week (5 sessions), fading by four weeks.'
        : 'It has played out within about two weeks (10 sessions), fading by four.';
    case 'slow':
      return t.best === 20
        ? 'It has been slow: weak in the first week, strongest over about four weeks (20 sessions).'
        : 'It has needed two weeks or more: weak in the first week, there from 10 sessions on.';
    case 'against':
      return `It has tended to point the wrong way, most clearly over ${t.best} sessions.`;
  }
}
