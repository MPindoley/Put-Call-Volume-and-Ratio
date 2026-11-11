/**
 * Signals together: is a stock with two signals pointing the same way a better
 * bet than either signal on its own? Pure; learning-jobs.ts does the I/O.
 *
 * THE QUESTION. The edge book learns each signal separately, and the scanner's
 * lean combines co-firing signals by a fixed rule (signed sum ÷ √m,
 * learning.ts). That rule is an assumption. This measures the thing itself:
 * for every pair of signal types and each direction,
 *
 *   together — days both fired on a name, pointing the same way
 *   A alone  — days A fired that way and B did not
 *   B alone  — days B fired that way and A did not
 *
 * each as a hit rate above the regime-matched base rate, on the same graded
 * signals, base rates and recency weights as the edge book.
 *
 * SHRUNK, AND SLOW TO CLAIM. "Alone" edges shrink toward zero. The "together"
 * edge shrinks toward the average of the two alone edges — the neutral guess
 * that company adds nothing — so a handful of co-firings cannot manufacture a
 * synergy. A pair is called stronger (or weaker) together only when the
 * together edge clears the better (or falls below the worse) of the two alone
 * edges by more than minEdge AND its own standard error, and nothing is said
 * below minGraded co-firings.
 *
 * DESCRIPTIVE. The lean's combination rule is not changed by this: it is the
 * rule self-grading holds to account. The table also shows what that rule
 * assumes for each pair, beside what was observed.
 */
import { CONVICTION_CAP, type Evidence } from './learning';
import { DIRECTIONAL_SIGNALS, type Direction } from './signals';

export const COMBO_PARAMS = {
  /** Prior strength, in effective graded signals. */
  prior: 40,
  /** Co-firings a pair needs before anything is said about it. */
  minGraded: 30,
  /** A difference smaller than this (hit-rate points) is not called a difference. */
  minEdge: 0.02,
} as const;

/** Sufficient statistics: graded signals, their recency-weighted count, and Σ w·(hit − base). */
export interface ComboStats {
  n: number;
  nEff: number;
  excess: number;
}

export interface PairStats {
  together: ComboStats;
  aAlone: ComboStats;
  bAlone: ComboStats;
}

/** Keyed `${a}+${b}|${direction}` with a before b in the signal grid's order. */
export type ComboBook = Record<string, PairStats>;

const empty = (): ComboStats => ({ n: 0, nEff: 0, excess: 0 });

/** Tally every pair from graded signals whose outcome was knowable by `asOfIdx` (rows without a base rate are skipped). */
export function buildComboBook(evidence: readonly Evidence[], asOfIdx: number, halfLifeSessions: number): ComboBook {
  // Signals by name, session and direction: type → that signal.
  const days = new Map<string, Map<string, Evidence>>();
  for (const e of evidence) {
    if (e.knownIdx > asOfIdx || e.base === null) continue;
    const key = `${e.symbol}|${e.firedIdx}|${e.direction}`;
    const day = days.get(key) ?? new Map<string, Evidence>();
    day.set(e.signalType, e);
    days.set(key, day);
  }
  const book: ComboBook = {};
  const add = (s: ComboStats, w: number, hit: boolean, base: number): void => {
    s.n += 1;
    s.nEff += w;
    s.excess += w * ((hit ? 1 : 0) - base);
  };
  const types = DIRECTIONAL_SIGNALS as readonly string[];
  for (const day of days.values()) {
    const any = day.values().next().value as Evidence;
    const w = 0.5 ** (Math.max(0, asOfIdx - any.firedIdx) / halfLifeSessions);
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const a = day.get(types[i]!);
        const b = day.get(types[j]!);
        if (!a && !b) continue;
        const pair = (book[`${types[i]}+${types[j]}|${any.direction}`] ??= {
          together: empty(),
          aAlone: empty(),
          bAlone: empty(),
        });
        // Same name, day and direction: one outcome. Their base rates can differ (each type has its own eligible days).
        if (a && b) add(pair.together, w, a.hit, ((a.base as number) + (b.base as number)) / 2);
        else if (a) add(pair.aAlone, w, a.hit, a.base as number);
        else if (b) add(pair.bAlone, w, b.hit, b.base as number);
      }
    }
  }
  return book;
}

export type ComboVerdict = 'learning' | 'stronger' | 'weaker' | 'same';

export interface ComboView {
  a: string;
  b: string;
  direction: Direction;
  /** Days both fired, pointing this way. */
  n: number;
  /** Learned edge on those days (hit-rate points above base); null below minGraded. */
  together: number | null;
  /** Approximate standard error of `together`. */
  se: number;
  aAlone: number;
  bAlone: number;
  nA: number;
  nB: number;
  /** What the lean's combination rule (signed sum ÷ √2, capped) assumes for the pair. */
  assumed: number;
  verdict: ComboVerdict;
}

/** Every pair with at least one co-firing, most co-firings first. */
export function comboViews(
  book: ComboBook,
  p: { prior: number; minGraded: number; minEdge: number } = COMBO_PARAMS,
): ComboView[] {
  const out: ComboView[] = [];
  for (const [key, s] of Object.entries(book)) {
    if (s.together.n === 0) continue;
    const [pair, direction] = key.split('|') as [string, Direction];
    const [a, b] = pair.split('+') as [string, string];
    const aAlone = s.aAlone.excess / (s.aAlone.nEff + p.prior);
    const bAlone = s.bAlone.excess / (s.bAlone.nEff + p.prior);
    const parent = (aAlone + bAlone) / 2;
    const together = (s.together.excess + p.prior * parent) / (s.together.nEff + p.prior);
    const se = Math.sqrt(0.25 / (s.together.nEff + p.prior));
    const floor = Math.max(p.minEdge, se);
    const verdict: ComboVerdict =
      s.together.n < p.minGraded
        ? 'learning'
        : together - Math.max(aAlone, bAlone) >= floor
          ? 'stronger'
          : Math.min(aAlone, bAlone) - together >= floor
            ? 'weaker'
            : 'same';
    out.push({
      a,
      b,
      direction,
      n: s.together.n,
      together: verdict === 'learning' ? null : together,
      se,
      aAlone,
      bAlone,
      nA: s.aAlone.n,
      nB: s.bAlone.n,
      assumed: Math.max(-CONVICTION_CAP, Math.min(CONVICTION_CAP, (aAlone + bAlone) / Math.SQRT2)),
      verdict,
    });
  }
  return out.sort(
    (x, y) => y.n - x.n || x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.direction.localeCompare(y.direction),
  );
}

/** Rounded for storage. */
export function compactComboBook(book: ComboBook): ComboBook {
  const round = (s: ComboStats): ComboStats => ({ n: s.n, nEff: Number(s.nEff.toFixed(3)), excess: Number(s.excess.toFixed(4)) });
  return Object.fromEntries(
    Object.entries(book).map(([k, v]) => [k, { together: round(v.together), aAlone: round(v.aAlone), bAlone: round(v.bAlone) }]),
  );
}
