/**
 * The edge book — what the app has learned about its own signals. Pure; all
 * DB access lives in learning-data.ts.
 *
 * WHAT IS LEARNED. Not prices. For every directional signal the app emits, how
 * much more often it lands on the predicted side than a no-skill guess would —
 * measured as a hit rate ABOVE the regime-matched base rate, on the 10-session
 * excess return vs SPY (the accuracy matrix's canonical setting, DECISIONS §4.6).
 * An edge of +0.06 means "hits 6 points more often than the base rate".
 *
 * HOW IT STAYS HONEST ON THIN DATA. Estimates are shrunk along a strictly
 * nested chain, each level pulled toward the one above:
 *
 *     no edge (0) → signal → signal·regime → ·sector → ·ticker
 *
 * A node with nEff effective observations and prior strength k moves from its
 * parent's estimate only in proportion nEff / (nEff + k). Deeper levels get a
 * larger k because they are thinner and there are many more of them (the
 * multiple-comparisons problem: some sector or ticker WILL look brilliant by
 * chance). A ticker with three graded signals therefore inherits almost all of
 * its estimate from its sector, and a signal with no history at all reads 0.
 *
 * RECENCY. Each observation is weighted 0.5^(age / halfLife) by when it fired,
 * so a signal that stops working fades instead of coasting on old wins.
 *
 * POINT-IN-TIME. A book "as of" session A uses only evidence whose outcome was
 * known by A (knownIdx ≤ A), and callers supply base rates as known at A too.
 * That is what lets past books be reconstructed and graded without peeking.
 *
 * NOT A MODEL. Deliberately no fitted predictor: at hundreds-to-low-thousands of
 * graded signals a model would memorise noise. These are shrinkage estimates
 * of a fixed signal grid (signals.ts: the grid is fixed; learning only weights
 * it, never adds to it).
 */
import type { Direction } from './signals';

export type Level = 'signal' | 'regime' | 'sector' | 'ticker';
export const LEVELS: readonly Level[] = ['signal', 'regime', 'sector', 'ticker'];

export interface LearningParams {
  horizon: 5 | 10 | 20;
  basis: 'exSpy' | 'exSector' | 'raw';
  /** Sessions for an observation's weight to halve. */
  halfLifeSessions: number;
  /** Prior strength per level, in effective observations. */
  prior: Record<Level, number>;
}

export const LEARNING_PARAMS: LearningParams = {
  horizon: 10,
  basis: 'exSpy',
  halfLifeSessions: 120,
  prior: { signal: 40, regime: 40, sector: 60, ticker: 80 },
};

/**
 * FNV-1a stamp over everything that changes what a book means: the learning
 * parameters plus the signal-definition and regime-definition versions the
 * evidence was filtered on. Books under different versions never mix.
 */
export function learningVersion(p: LearningParams, thresholdVersion: string, regimeConfigVersion: string): string {
  const s =
    `l1|h=${p.horizon}|b=${p.basis}|hl=${p.halfLifeSessions}` +
    `|k=${p.prior.signal},${p.prior.regime},${p.prior.sector},${p.prior.ticker}` +
    `|t=${thresholdVersion}|r=${regimeConfigVersion}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** What identifies a signal for learning purposes. */
export interface SignalKey {
  signalType: string;
  direction: Direction;
  /** `${vol}|${trend}` at fire time (gamma omitted: null on backfilled history). */
  regime: string;
  sector: string;
  symbol: string;
}

/** One graded signal, reduced to what learning needs. */
export interface Evidence extends SignalKey {
  /** Session index the signal fired on. */
  firedIdx: number;
  /** Session index by which its outcome was knowable (endpoint, or later). */
  knownIdx: number;
  hit: boolean;
  /** No-skill hit probability for this row AS KNOWN at the book date. Null → unusable. */
  base: number | null;
}

export function nodeKey(level: Level, k: SignalKey): string {
  const parts = [k.signalType, k.direction];
  if (level !== 'signal') parts.push(k.regime);
  if (level === 'sector' || level === 'ticker') parts.push(k.sector);
  if (level === 'ticker') parts.push(k.symbol);
  return `${level}:${parts.join('|')}`;
}

/** Sufficient statistics for one node. `excess` = Σ w·(hit − base). */
export interface NodeStats {
  n: number;
  nEff: number;
  excess: number;
}

export interface EdgeBook {
  version: string;
  asOfIdx: number;
  params: LearningParams;
  nodes: Record<string, NodeStats>;
  /** Evidence rows that entered the book. */
  rowsUsed: number;
  /** Rows known by asOf but without a base rate (cannot measure excess → skipped). */
  rowsUnbased: number;
}

export function buildEdgeBook(
  evidence: readonly Evidence[],
  asOfIdx: number,
  version: string,
  params: LearningParams = LEARNING_PARAMS,
): EdgeBook {
  const nodes: Record<string, NodeStats> = {};
  let rowsUsed = 0;
  let rowsUnbased = 0;
  for (const e of evidence) {
    if (e.knownIdx > asOfIdx) continue; // not knowable yet — the PIT rule
    if (e.base === null) {
      rowsUnbased += 1;
      continue;
    }
    const age = Math.max(0, asOfIdx - e.firedIdx);
    const w = 0.5 ** (age / params.halfLifeSessions);
    const contrib = w * ((e.hit ? 1 : 0) - e.base);
    for (const level of LEVELS) {
      const key = nodeKey(level, e);
      const s = (nodes[key] ??= { n: 0, nEff: 0, excess: 0 });
      s.n += 1;
      s.nEff += w;
      s.excess += contrib;
    }
    rowsUsed += 1;
  }
  return { version, asOfIdx, params, nodes, rowsUsed, rowsUnbased };
}

export interface PathStep {
  level: Level;
  key: string;
  n: number;
  nEff: number;
  /** The node's own unshrunk edge, or null with no data. */
  raw: number | null;
  /** Shrunk estimate at this level. */
  edge: number;
  /** Share of this level's estimate that comes from its own data, 0..1. */
  evidence: number;
}

export interface EdgeEstimate {
  /** Final shrunk edge (hit-rate points above base; + favours the signal's direction). */
  edge: number;
  /** Approximate standard error of `edge`. */
  se: number;
  /** Graded signals behind the most specific level that has any data. */
  n: number;
  path: PathStep[];
}

/** Walk the chain from "no edge" down to the ticker, shrinking at every level. */
export function estimateEdge(book: EdgeBook, key: SignalKey): EdgeEstimate {
  let parent = 0;
  let deepestInfo = book.params.prior.signal; // prior-only precision if no data anywhere
  let n = 0;
  const path: PathStep[] = [];
  for (const level of LEVELS) {
    const k = book.params.prior[level];
    const nk = nodeKey(level, key);
    const s = book.nodes[nk];
    if (!s || s.nEff <= 0) {
      path.push({ level, key: nk, n: 0, nEff: 0, raw: null, edge: parent, evidence: 0 });
      continue;
    }
    const edge = (s.excess + k * parent) / (s.nEff + k);
    path.push({ level, key: nk, n: s.n, nEff: s.nEff, raw: s.excess / s.nEff, edge, evidence: s.nEff / (s.nEff + k) });
    parent = edge;
    deepestInfo = s.nEff + k;
    n = s.n;
  }
  // Bernoulli variance ≤ 0.25 → a conservative, explainable precision bound.
  return { edge: parent, se: Math.sqrt(0.25 / deepestInfo), n, path };
}

export interface SignalSummary {
  signalType: string;
  direction: Direction;
  n: number;
  raw: number | null;
  edge: number;
  se: number;
  evidence: number;
  regimes: { regime: string; n: number; raw: number | null; edge: number; evidence: number }[];
}

/** Signal- and regime-level estimates in a book — "what has it learned", for display. */
export function summarizeBook(book: EdgeBook): SignalSummary[] {
  const out: SignalSummary[] = [];
  for (const key of Object.keys(book.nodes)) {
    if (!key.startsWith('signal:')) continue;
    const [signalType, direction] = key.slice('signal:'.length).split('|') as [string, Direction];
    const base: SignalKey = { signalType, direction, regime: '', sector: '', symbol: '' };
    const top = estimateEdge(book, base);
    const sig = top.path[0]!;
    const regimes: SignalSummary['regimes'] = [];
    const prefix = `regime:${signalType}|${direction}|`;
    for (const rk of Object.keys(book.nodes)) {
      if (!rk.startsWith(prefix)) continue;
      const regime = rk.slice(prefix.length);
      const step = estimateEdge(book, { ...base, regime }).path[1]!;
      regimes.push({ regime, n: step.n, raw: step.raw, edge: step.edge, evidence: step.evidence });
    }
    regimes.sort((a, b) => b.n - a.n);
    out.push({
      signalType,
      direction,
      n: sig.n,
      raw: sig.raw,
      edge: sig.edge,
      se: Math.sqrt(0.25 / (sig.nEff + book.params.prior.signal)),
      evidence: sig.evidence,
      regimes,
    });
  }
  return out.sort((a, b) => a.signalType.localeCompare(b.signalType) || a.direction.localeCompare(b.direction));
}

// ─── Conviction ───────────────────────────────────────────────────────────────

/** Below this (hit-rate points) a conviction is shown as "—": not worth a number. */
export const CONVICTION_DISPLAY_FLOOR = 0.01;
/** Hard bound: no combination of learned edges claims more than this. */
export const CONVICTION_CAP = 0.25;

export interface ConvictionPart {
  signalType: string;
  direction: Direction;
  edge: number;
  se: number;
  n: number;
  /** Own-data share at the signal level (how established this signal type is overall). */
  signalEvidence: number;
}

export interface Conviction {
  /** Signed learned lean: + bullish, − bearish, in hit-rate points above base. */
  score: number;
  direction: Direction | null;
  /** True when there is nothing worth showing (no signals, or a negligible net). */
  thin: boolean;
  parts: ConvictionPart[];
}

/**
 * Combine the learned edges of every signal active on a ticker into one lean.
 *
 * Each signal contributes its edge signed by its direction (a bearish signal
 * with a positive edge pushes bearish). Opposing signals net out. Co-firing
 * signals are often correlated (skew_z and divergence both read skew), so a
 * plain sum would overstate them and a plain mean would understate independent
 * confirmation; the sum is divided by √m as the standard compromise for
 * partially correlated evidence, and capped. This combination is itself on
 * trial: self-grading measures whether it is over- or under-confident.
 */
export function combineConviction(book: EdgeBook, active: readonly SignalKey[]): Conviction {
  if (active.length === 0) return { score: 0, direction: null, thin: true, parts: [] };
  const parts: ConvictionPart[] = active.map((key) => {
    const est = estimateEdge(book, key);
    return {
      signalType: key.signalType,
      direction: key.direction,
      edge: est.edge,
      se: est.se,
      n: est.n,
      signalEvidence: est.path[0]?.evidence ?? 0,
    };
  });
  const signed = parts.reduce((sum, p) => sum + (p.direction === 'bullish' ? p.edge : -p.edge), 0);
  const raw = signed / Math.sqrt(parts.length);
  const score = Math.max(-CONVICTION_CAP, Math.min(CONVICTION_CAP, raw));
  const thin = Math.abs(score) < CONVICTION_DISPLAY_FLOOR;
  return { score, direction: thin ? null : score > 0 ? 'bullish' : 'bearish', thin, parts };
}

// ─── Point-in-time base rates ─────────────────────────────────────────────────

/**
 * One eligible day for one signal type on one name: the forward excess return
 * from that day, used to measure how often the name rises/falls with NO signal
 * (the regime-matched base rate — DECISIONS §4.6, same rules as matrix-data).
 */
export interface DayObs {
  type: string;
  symbol: string;
  /** Full regime triple `${vol}|${trend}|${gamma ?? 'na'}` on that day. */
  cell: string;
  /** Session index by which the day's forward return was knowable. */
  knownIdx: number;
  ret: number;
}

interface Counts {
  pos: number;
  neg: number;
  total: number;
}

export type BaseRateFn = (type: string, symbol: string, cell: string, direction: Direction) => number | null;

/**
 * Base-rate lookup as known at `asOfIdx`: the ticker's own in-regime day counts
 * when it has at least `minTickerDays`, otherwise its cohort's pooled counts —
 * the matrix's rule, restricted to days whose outcome was knowable by asOf.
 */
export function buildBaseRates(
  days: readonly DayObs[],
  asOfIdx: number,
  minTickerDays: number,
  cohortOf: (symbol: string) => string | null,
): BaseRateFn {
  const ticker = new Map<string, Counts>();
  const cohort = new Map<string, Counts>();
  const bump = (m: Map<string, Counts>, k: string, ret: number): void => {
    const c = m.get(k) ?? { pos: 0, neg: 0, total: 0 };
    if (ret > 0) c.pos += 1;
    else if (ret < 0) c.neg += 1;
    c.total += 1;
    m.set(k, c);
  };
  for (const d of days) {
    if (d.knownIdx > asOfIdx) continue;
    bump(ticker, `${d.type}|${d.symbol}|${d.cell}`, d.ret);
    const co = cohortOf(d.symbol);
    if (co) bump(cohort, `${d.type}|${co}|${d.cell}`, d.ret);
  }
  return (type, symbol, cell, direction) => {
    const own = ticker.get(`${type}|${symbol}|${cell}`);
    let c: Counts | undefined = own && own.total >= minTickerDays ? own : undefined;
    if (!c) {
      const co = cohortOf(symbol);
      c = co ? cohort.get(`${type}|${co}|${cell}`) : undefined;
    }
    if (!c || c.total <= 0) return null;
    return (direction === 'bullish' ? c.pos : c.neg) / c.total;
  };
}
