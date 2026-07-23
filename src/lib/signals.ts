/**
 * Phase 4 signal grid + conditional-matrix math. All pure and unit-tested.
 *
 * THE GRID IS FIXED (fixed before looking at results — multiple-comparisons
 * discipline). Directional matrix: divergence, skew_z, pc_extreme, spike_alert.
 * Separate tracks: event_badge (rich/cheap vs realized-under/over-implied, its own
 * hit definition and base rate), backwardation and regime_detach
 * (magnitude/episode analysis, no directional hit). A future signal type is a NEW
 * type reported separately — never folded into this matrix.
 *
 * Hit is defined on the EXCESS return by default (a bullish signal that returned
 * +2% while the market did +4% is not a hit); raw is an explicit basis toggle.
 */

export const DIRECTIONAL_SIGNALS = ['divergence', 'skew_z', 'pc_extreme', 'spike_alert'] as const;
export const TRACK_SIGNALS = ['event_badge', 'backwardation', 'regime_detach'] as const;
export type SignalType = (typeof DIRECTIONAL_SIGNALS)[number] | (typeof TRACK_SIGNALS)[number];

/** Backwardation flag threshold (matches chain-analytics `backwardated`). Part of thresholdVersion. */
export const BACKWARDATION_SLOPE = -0.5;

/** FNV-1a stamp of the signal-defining cutoffs — the thresholdVersion discipline. */
export function thresholdVersion(cfg: {
  skewZExtreme: number;
  pcHigh: number;
  pcLow: number;
  divergenceTStat: number;
}): string {
  const s = `t1|skewZ=${cfg.skewZExtreme}|pcHi=${cfg.pcHigh}|pcLo=${cfg.pcLow}|divT=${cfg.divergenceTStat}|bwd=${BACKWARDATION_SLOPE}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Wilson score interval for a binomial proportion — the cheap, honest CI on a
 * cell's hit rate. Returns [lo, hi] in [0,1]; null when n = 0.
 */
export function wilsonInterval(hits: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * PRIMARY backwardation resolution: the curve shape. When a backwardated term
 * structure normalizes, either the near end fell to meet the back
 * (**front_collapse** — the feared event passed and front vol drained) or the far
 * end rose to meet the front (**back_lift** — the fear repriced as durable and
 * spread down the curve). Classified once, at close, from the persisted
 * term-structure components: whichever side moved MORE toward normalization wins
 * (−ΔNear vs +ΔFar). Missing inputs → 'unknown', never guessed.
 */
export function classifyCurveResolution(
  entryIvNear: number | null,
  entryIvFar: number | null,
  exitIvNear: number | null,
  exitIvFar: number | null,
): 'front_collapse' | 'back_lift' | 'unknown' {
  if (entryIvNear === null || entryIvFar === null || exitIvNear === null || exitIvFar === null) return 'unknown';
  const nearFall = entryIvNear - exitIvNear; // >0 when the front collapsed
  const farRise = exitIvFar - entryIvFar; // >0 when the back lifted
  if (nearFall <= 0 && farRise <= 0) return 'unknown'; // neither side normalized (shouldn't close)
  return nearFall >= farRise ? 'front_collapse' : 'back_lift';
}

/**
 * SECONDARY outcome class. Fixed classification constants (documented, not
 * tunable config — they label outcomes, they don't define signals):
 *   realized_move — the underlying moved ≥5% cumulatively (the fear realized);
 *   iv_crush      — IV30 fell ≥5 vol pts with the move under 5% (vol came out calmly);
 *   faded         — neither: the term structure just relaxed.
 */
export function classifyResolution(
  cumReturn: number | null,
  entryIv30: number | null,
  exitIv30: number | null,
): 'realized_move' | 'iv_crush' | 'faded' {
  if (cumReturn !== null && Math.abs(cumReturn) >= 0.05) return 'realized_move';
  if (entryIv30 !== null && exitIv30 !== null && entryIv30 - exitIv30 >= 5) return 'iv_crush';
  return 'faded';
}

// ─── Conditional matrix ───────────────────────────────────────────────────────

export type Direction = 'bullish' | 'bearish';

/** One scored directional signal prepared for aggregation (basis/horizon already chosen). */
export interface MatrixRow {
  signalType: string;
  direction: Direction;
  regimeVol: string | null;
  regimeTrend: string | null;
  /** null → a 2-D (pre-gamma-capture) signal; bucketed as 'na', never dropped. */
  regimeGamma: string | null;
  /** Forward return on the chosen basis/horizon (log, signed). */
  ret: number | null;
  /** Regime-matched no-skill hit probability for THIS row (per its ticker or cohort). */
  baseHitProb: number | null;
  baseSource: 'ticker' | 'cohort' | null;
}

export interface MatrixCell {
  signalType: string;
  regimeVol: string;
  regimeTrend: string;
  regimeGamma: string; // 'pos' | 'neg' | 'na'
  n: number;
  hits: number;
  hitRate: number;
  /** Mean regime-matched base hit probability across the cell's rows. */
  baseRate: number | null;
  /** hitRate − baseRate: the headline figure. */
  excess: number | null;
  avgRet: number;
  wilson: { lo: number; hi: number } | null;
  baseSource: 'ticker' | 'cohort' | 'mixed' | null;
  suppressed: boolean;
}

export interface MatrixResult {
  cells: MatrixCell[];
  /** Non-empty cells examined (the denominator someone will ask about). */
  cellsTested: number;
  suppressedCells: number;
  /** Cells expected to clear |z|≥1.96 by chance alone at α=0.05 given cellsTested. */
  expectedByChance: number;
}

const cellKey = (r: MatrixRow): string =>
  `${r.signalType}|${r.regimeVol ?? 'na'}|${r.regimeTrend ?? 'na'}|${r.regimeGamma ?? 'na'}`;

/**
 * Aggregate scored directional rows into the signal×regime matrix. A hit is a
 * forward return on the predicted side (bullish → ret>0, bearish → ret<0) on the
 * chosen basis. Cells under `minCellSample` are marked suppressed (the API strips
 * their statistics, keeping n so the UI can show warming coverage honestly).
 */
export function buildMatrix(rows: MatrixRow[], minCellSample: number): MatrixResult {
  const byCell = new Map<string, MatrixRow[]>();
  for (const r of rows) {
    if (r.ret === null) continue;
    const k = cellKey(r);
    const list = byCell.get(k) ?? [];
    list.push(r);
    byCell.set(k, list);
  }
  const cells: MatrixCell[] = [];
  for (const list of byCell.values()) {
    const first = list[0]!;
    const hits = list.filter((r) => (r.direction === 'bullish' ? (r.ret as number) > 0 : (r.ret as number) < 0)).length;
    const n = list.length;
    const bases = list.map((r) => r.baseHitProb).filter((b): b is number => b !== null);
    const baseRate = bases.length === n ? bases.reduce((a, b) => a + b, 0) / n : null;
    const sources = new Set(list.map((r) => r.baseSource).filter((s) => s !== null));
    cells.push({
      signalType: first.signalType,
      regimeVol: first.regimeVol ?? 'na',
      regimeTrend: first.regimeTrend ?? 'na',
      regimeGamma: first.regimeGamma ?? 'na',
      n,
      hits,
      hitRate: hits / n,
      baseRate,
      excess: baseRate !== null ? hits / n - baseRate : null,
      avgRet: list.reduce((s, r) => s + (r.ret as number), 0) / n,
      wilson: wilsonInterval(hits, n),
      baseSource: sources.size === 0 ? null : sources.size > 1 ? 'mixed' : ([...sources][0] as 'ticker' | 'cohort'),
      suppressed: n < minCellSample,
    });
  }
  cells.sort((a, b) => a.signalType.localeCompare(b.signalType) || b.n - a.n);
  const tested = cells.length;
  return {
    cells,
    cellsTested: tested,
    suppressedCells: cells.filter((c) => c.suppressed).length,
    expectedByChance: Number((tested * 0.05).toFixed(1)),
  };
}

// ─── Base rates ───────────────────────────────────────────────────────────────

/** Directional day counts for one (ticker, regime-cell): positives/negatives of the excess return. */
export interface DayCounts {
  pos: number;
  neg: number;
  total: number;
}

/** No-skill hit probability for a direction given day counts (zeros count against). */
export function baseHitProb(counts: DayCounts, direction: Direction): number | null {
  if (counts.total <= 0) return null;
  return (direction === 'bullish' ? counts.pos : counts.neg) / counts.total;
}

/** Merge day counts (cohort fallback = sum over members). */
export function mergeCounts(list: DayCounts[]): DayCounts {
  return list.reduce((a, b) => ({ pos: a.pos + b.pos, neg: a.neg + b.neg, total: a.total + b.total }), {
    pos: 0,
    neg: 0,
    total: 0,
  });
}

// ─── Event-badge track ────────────────────────────────────────────────────────

export interface EventTrackRow {
  prediction: 'rich' | 'cheap';
  impliedMove: number;
  realizedMove: number;
}

export interface EventTrackSummary {
  n: number;
  hits: number;
  hitRate: number | null;
  /** Unconditional base: share of events where realized < implied (the 'rich' base;
   *  the 'cheap' base is its complement). */
  undershootBase: number | null;
  wilson: { lo: number; hi: number } | null;
}

/**
 * Event-badge hit: 'rich' predicts realized UNDER implied, 'cheap' predicts
 * realized OVER implied; hit = realized landed on the predicted side. Base-rate
 * discipline: compare against how often events undershoot implied unconditionally
 * (`baseEvents` = all scored events regardless of badge).
 */
export function eventTrackSummary(
  rows: EventTrackRow[],
  baseEvents: { impliedMove: number; realizedMove: number }[],
): EventTrackSummary {
  const hits = rows.filter((r) =>
    r.prediction === 'rich' ? r.realizedMove < r.impliedMove : r.realizedMove > r.impliedMove,
  ).length;
  const undershoots = baseEvents.filter((e) => e.realizedMove < e.impliedMove).length;
  return {
    n: rows.length,
    hits,
    hitRate: rows.length > 0 ? hits / rows.length : null,
    undershootBase: baseEvents.length > 0 ? undershoots / baseEvents.length : null,
    wilson: wilsonInterval(hits, rows.length),
  };
}
