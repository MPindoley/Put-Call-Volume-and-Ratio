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
  // Every constant that changes what a stored book means is in here — the
  // base-rate sample floor, the frozen-price rule and the conviction combination
  // included — so a rule change starts a new series instead of mislabelling one.
  const s =
    `l1|h=${p.horizon}|b=${p.basis}|hl=${p.halfLifeSessions}` +
    `|k=${p.prior.signal},${p.prior.regime},${p.prior.sector},${p.prior.ticker}` +
    `|mb=${MIN_BASE_SAMPLE}|fr=${FROZEN_RUN_SESSIONS}|cap=${CONVICTION_CAP}|comb=sqrtm` +
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
 * Fewest observations a base rate may rest on. Point-in-time base rates are
 * built only from days already knowable, so early on a cohort's "ordinary day"
 * can rest on two or three observations and read 0% or 100% — which would make
 * any excess measured against it meaningless (observed: a replay whose early
 * bases averaged 37% on data whose true base was ~50%, inflating the measured
 * edge by ~13 points). Below this, there is no base rate: the row is skipped
 * as unbased, never measured against noise.
 */
export const MIN_BASE_SAMPLE = 30;

/**
 * Point-in-time base rates, advanced forward through time.
 *
 * Rebuilding base rates from scratch for every session is O(days × sessions):
 * ~2,000 eligible stock-days per session means ~130M operations to backfill a
 * year of books. The sweep instead sorts days by when their outcome became
 * knowable and adds them incrementally as `advanceTo` moves forward, so a whole
 * backfill (or a self-grading replay) costs one pass. It can only move forward
 * — exactly the point-in-time direction.
 */
export class BaseRateSweep {
  private readonly days: DayObs[];
  private next = 0;
  private asOf = -Infinity;
  private readonly ticker = new Map<string, Counts>();
  private readonly cohort = new Map<string, Counts>();

  constructor(
    days: readonly DayObs[],
    private readonly minTickerDays: number,
    private readonly cohortOf: (symbol: string) => string | null,
    private readonly minSample = MIN_BASE_SAMPLE,
  ) {
    this.days = [...days].sort((a, b) => a.knownIdx - b.knownIdx);
  }

  /** Include every day knowable by `asOfIdx`. Never moves backward. */
  advanceTo(asOfIdx: number): this {
    if (asOfIdx < this.asOf) throw new Error(`BaseRateSweep cannot move backward (${asOfIdx} < ${this.asOf})`);
    this.asOf = asOfIdx;
    while (this.next < this.days.length && this.days[this.next]!.knownIdx <= asOfIdx) {
      const d = this.days[this.next++]!;
      this.bump(this.ticker, `${d.type}|${d.symbol}|${d.cell}`, d.ret);
      const co = this.cohortOf(d.symbol);
      if (co) this.bump(this.cohort, `${d.type}|${co}|${d.cell}`, d.ret);
    }
    return this;
  }

  /**
   * The ticker's own in-regime counts when it has at least `minTickerDays`,
   * otherwise its cohort's pooled counts — the matrix's rule. Null when fewer
   * than `minSample` observations back it: never a guess.
   */
  readonly lookup: BaseRateFn = (type, symbol, cell, direction) => {
    const own = this.ticker.get(`${type}|${symbol}|${cell}`);
    let c: Counts | undefined = own && own.total >= this.minTickerDays ? own : undefined;
    if (!c) {
      const co = this.cohortOf(symbol);
      c = co ? this.cohort.get(`${type}|${co}|${cell}`) : undefined;
    }
    if (!c || c.total < Math.max(1, this.minSample)) return null;
    return (direction === 'bullish' ? c.pos : c.neg) / c.total;
  };

  private bump(m: Map<string, Counts>, k: string, ret: number): void {
    const c = m.get(k) ?? { pos: 0, neg: 0, total: 0 };
    if (ret > 0) c.pos += 1;
    else if (ret < 0) c.neg += 1;
    c.total += 1;
    m.set(k, c);
  }
}

/** One-shot base rates as known at `asOfIdx` (a sweep advanced once). */
export function buildBaseRates(
  days: readonly DayObs[],
  asOfIdx: number,
  minTickerDays: number,
  cohortOf: (symbol: string) => string | null,
  minSample = MIN_BASE_SAMPLE,
): BaseRateFn {
  return new BaseRateSweep(days, minTickerDays, cohortOf, minSample).advanceTo(asOfIdx).lookup;
}

// ─── Data health ──────────────────────────────────────────────────────────────

/** Consecutive identical closes at which a price is treated as frozen, not traded. */
export const FROZEN_RUN_SESSIONS = 5;

/**
 * Sessions on which a name's close was FROZEN: part of a run of at least
 * `minRun` consecutive sessions with an identical close. A traded stock
 * essentially never settles at exactly the same price five sessions running;
 * a halted or delisted one does, and CBOE serves its last snapshot forever
 * (measured: DFS frozen 451 days). Before the runtime stale-snapshot guard
 * existed, those ghosts could be captured as "final" closes. Learning excludes
 * them — a 0% "return" off a ghost price is not evidence of anything.
 */
export function frozenSessions(
  closes: ReadonlyMap<string, number>,
  sessions: readonly string[],
  minRun = FROZEN_RUN_SESSIONS,
): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  let last: number | undefined;
  const flush = (): void => {
    if (run.length >= minRun) for (const d of run) out.add(d);
  };
  for (const d of sessions) {
    const c = closes.get(d);
    if (c === undefined) {
      flush();
      run = [];
      last = undefined;
      continue;
    }
    if (last !== undefined && c === last) run.push(d);
    else {
      flush();
      run = [d];
    }
    last = c;
  }
  flush();
  return out;
}

// ─── Self-grading ─────────────────────────────────────────────────────────────

/**
 * One past conviction, graded. The forecast is "this name lands on the
 * predicted side `q` points more often than its base rate"; the outcome is
 * whether it did.
 */
export interface Forecast {
  asOfIdx: number;
  symbol: string;
  direction: Direction;
  /** Predicted excess hit probability (|conviction|), > 0. */
  q: number;
  /** No-skill hit probability for that direction, as known at asOf. */
  base: number;
  hit: boolean;
}

export interface CalibrationBin {
  label: string;
  n: number;
  /** Mean predicted excess (q) in the bin. */
  predicted: number;
  /** Realized excess: hit rate − mean base. */
  realized: number;
  hitRate: number;
  base: number;
  /** 95% interval on the realized excess (Wilson on the hit rate, minus base). */
  ci: { lo: number; hi: number } | null;
}

export interface Calibration {
  n: number;
  hitRate: number | null;
  base: number | null;
  /** Mean predicted vs realized excess — calibration-in-the-large. */
  predicted: number | null;
  realized: number | null;
  ci: { lo: number; hi: number } | null;
  /**
   * Brier skill vs the no-skill forecast (p = base): > 0 means the learning adds
   * information beyond base rates; < 0 means it is making things worse.
   */
  skill: number | null;
  bins: CalibrationBin[];
  /** Same statistics per calendar month of the forecast date — the trend. */
  byMonth: { month: string; n: number; realized: number; predicted: number; skill: number | null }[];
}

/** Wilson score interval (local copy keeps learning.ts free of runtime imports). */
function wilson(hits: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

const BINS: { label: string; lo: number; hi: number }[] = [
  { label: '1–3 pts', lo: 0.01, hi: 0.03 },
  { label: '3–6 pts', lo: 0.03, hi: 0.06 },
  { label: '6–10 pts', lo: 0.06, hi: 0.1 },
  { label: '10+ pts', lo: 0.1, hi: Infinity },
];

function summarize(fs: readonly Forecast[]): {
  n: number;
  hits: number;
  hitRate: number;
  base: number;
  predicted: number;
  realized: number;
  ci: { lo: number; hi: number } | null;
  skill: number | null;
} | null {
  if (fs.length === 0) return null;
  const n = fs.length;
  const hits = fs.filter((f) => f.hit).length;
  const base = fs.reduce((s, f) => s + f.base, 0) / n;
  const predicted = fs.reduce((s, f) => s + f.q, 0) / n;
  const hitRate = hits / n;
  const w = wilson(hits, n);
  let bsModel = 0;
  let bsRef = 0;
  for (const f of fs) {
    const y = f.hit ? 1 : 0;
    const p = Math.min(0.99, Math.max(0.01, f.base + f.q));
    bsModel += (p - y) ** 2;
    bsRef += (f.base - y) ** 2;
  }
  return {
    n,
    hits,
    hitRate,
    base,
    predicted,
    realized: hitRate - base,
    ci: w ? { lo: w.lo - base, hi: w.hi - base } : null,
    skill: bsRef > 0 ? 1 - bsModel / bsRef : null,
  };
}

/**
 * Did the convictions mean what they said? A well-calibrated learner's 6-point
 * leans land ~6 points above base. Bins expose over-/under-confidence; Brier
 * skill answers "better than just knowing the base rate?"; the monthly series
 * answers "is it getting better?".
 */
export function calibrate(forecasts: readonly Forecast[], sessions: readonly string[]): Calibration {
  const all = summarize(forecasts);
  const bins: CalibrationBin[] = [];
  for (const b of BINS) {
    const s = summarize(forecasts.filter((f) => f.q >= b.lo && f.q < b.hi));
    if (!s) continue;
    bins.push({ label: b.label, n: s.n, predicted: s.predicted, realized: s.realized, hitRate: s.hitRate, base: s.base, ci: s.ci });
  }
  const byMonthMap = new Map<string, Forecast[]>();
  for (const f of forecasts) {
    const month = (sessions[f.asOfIdx] ?? '').slice(0, 7);
    const list = byMonthMap.get(month) ?? [];
    list.push(f);
    byMonthMap.set(month, list);
  }
  const byMonth = [...byMonthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, fs]) => {
      const s = summarize(fs)!;
      return { month, n: s.n, realized: s.realized, predicted: s.predicted, skill: s.skill };
    });
  return {
    n: all?.n ?? 0,
    hitRate: all?.hitRate ?? null,
    base: all?.base ?? null,
    predicted: all?.predicted ?? null,
    realized: all?.realized ?? null,
    ci: all?.ci ?? null,
    skill: all?.skill ?? null,
    bins,
    byMonth,
  };
}

/** Share of own-data weight at which an estimate counts as "established". */
export const ESTABLISHED_EVIDENCE = 0.5;

/** How many nodes per level have earned at least half their weight from their own data. */
export function establishedCounts(book: EdgeBook): Record<Level, { established: number; total: number }> {
  const out = Object.fromEntries(LEVELS.map((l) => [l, { established: 0, total: 0 }])) as Record<
    Level,
    { established: number; total: number }
  >;
  for (const [key, s] of Object.entries(book.nodes)) {
    const level = key.slice(0, key.indexOf(':')) as Level;
    if (!out[level]) continue;
    out[level].total += 1;
    if (s.nEff / (s.nEff + book.params.prior[level]) >= ESTABLISHED_EVIDENCE) out[level].established += 1;
  }
  return out;
}
