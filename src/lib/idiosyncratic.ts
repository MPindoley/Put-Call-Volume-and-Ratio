/**
 * Idiosyncratic event detector — a per-ticker history of large UNSCHEDULED
 * single-name moves. Detects on the idiosyncratic residual (return minus the
 * benchmark-explained part), not the raw move, so a market-wide day where
 * everything moves together is not flagged.
 *
 * This used to be an earnings-inference detector, but price history alone cannot
 * separate earnings from product launches, analyst days and other single-name
 * catalysts, and it misses quiet earnings — so it is repurposed as its own
 * feature and NO LONGER feeds the earnings realized-move distribution. Earnings
 * come from the calendar (manual + forward-confirmed) instead. It regresses
 * against SPY specifically: a mega-cap is a heavy weight in its own sector SPDR,
 * so a concentrated sector ETF absorbs the name's move and shrinks the residual.
 */
import { median, simpleRegression, stdev } from './sector-stats';

export interface DailyClose {
  /** ET ISO date (YYYY-MM-DD) — one trading session. */
  date: string;
  close: number;
}

export interface IdiosyncraticEvent {
  date: string;
  /** Signed total one-session log return. */
  returnPct: number;
  /** Signed idiosyncratic residual (return minus benchmark-explained part). */
  residualPct: number;
  /** |returnPct| — the total single-session move magnitude. */
  movePct: number;
  /** Residual magnitude in robust sigmas — the detection statistic. */
  residualZ: number;
}

export interface DetectOptions {
  /** Flag a session whose |residual| exceeds this many robust sigmas of the residual series. */
  moveZ: number;
  /** Minimum RAW |return| — guards against a large residual driven by a benchmark
   *  artifact (e.g. a holiday-misaligned close) while the stock barely moved. */
  minMovePct: number;
  /** Trailing sessions used for the rolling benchmark regression. */
  betaWindow: number;
  /** Minimum aligned sessions of history required. */
  minSessions: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  moveZ: 3.5,
  minMovePct: 0.02,
  betaWindow: 60,
  minSessions: 90,
};

/**
 * MAD-based robust sigma (1.4826·median|x−median|). When the MAD collapses to
 * zero — more than half the values identical — fall back to the ordinary stdev so
 * the threshold stays finite instead of the detector silently going dark.
 */
export function robustSigma(values: number[]): number {
  const m = median(values);
  if (m === null) return 0;
  const mad = median(values.map((r) => Math.abs(r - m)));
  if (mad !== null && mad > 0) return 1.4826 * mad;
  return stdev(values) ?? 0;
}

interface AlignedReturn {
  date: string;
  ri: number;
  rb: number;
}

function alignedReturns(closes: DailyClose[], benchmark: DailyClose[]): AlignedReturn[] {
  const bench = new Map(benchmark.map((c) => [c.date, c.close]));
  const shared = closes.filter((c) => bench.has(c.date));
  const out: AlignedReturn[] = [];
  for (let i = 1; i < shared.length; i++) {
    const p0 = shared[i - 1]!.close;
    const p1 = shared[i]!.close;
    const b0 = bench.get(shared[i - 1]!.date)!;
    const b1 = bench.get(shared[i]!.date)!;
    if (p0 > 0 && p1 > 0 && b0 > 0 && b1 > 0) {
      out.push({ date: shared[i]!.date, ri: Math.log(p1 / p0), rb: Math.log(b1 / b0) });
    }
  }
  return out;
}

/**
 * Detect large idiosyncratic single-session moves. `benchmark` should be the
 * broad market (SPY). `marketWideDates` (from {@link computeMarketWideDates})
 * excludes sessions where a share of the universe moved together — a market
 * event by definition, not a single-name one. The raw-move floor drops a large
 * residual paired with a near-zero stock move (a benchmark data artifact).
 */
export function detectIdiosyncraticEvents(
  closes: DailyClose[],
  benchmark: DailyClose[],
  marketWideDates: ReadonlySet<string> = new Set(),
  opts: DetectOptions = DEFAULT_DETECT_OPTIONS,
): IdiosyncraticEvent[] {
  if (closes.length < opts.minSessions) return [];
  const rows = alignedReturns(closes, benchmark);
  if (rows.length < opts.minSessions) return [];

  // Rolling residuals: β from the trailing window preceding each session (no
  // look-ahead), so a drifting beta is tracked and the move day never inflates its own fit.
  const resid: { date: string; ri: number; e: number }[] = [];
  for (let t = opts.betaWindow; t < rows.length; t++) {
    const win = rows.slice(t - opts.betaWindow, t);
    const fit = simpleRegression(
      win.map((r) => r.rb),
      win.map((r) => r.ri),
    );
    if (!fit) continue;
    const row = rows[t]!;
    resid.push({ date: row.date, ri: row.ri, e: row.ri - (fit.alpha + fit.beta * row.rb) });
  }
  const sigma = robustSigma(resid.map((r) => r.e));
  if (!(sigma > 0)) return [];

  return resid
    .filter(
      (r) => Math.abs(r.e) / sigma >= opts.moveZ && Math.abs(r.ri) >= opts.minMovePct && !marketWideDates.has(r.date),
    )
    .map((r) => ({
      date: r.date,
      returnPct: r.ri,
      residualPct: r.e,
      movePct: Math.abs(r.ri),
      residualZ: Math.abs(r.e) / sigma,
    }));
}

/**
 * Sessions where a configurable share of the tracked universe moved sharply — a
 * market-wide day. `returnsByTicker` is each ticker's per-session log returns; a
 * session is "sharp" for a ticker when |return| ≥ `breadthMoveZ`·(that ticker's
 * robust σ). A date is market-wide when it has ≥ `minTickers` observations and
 * the sharp share meets `breadthShare`.
 */
export function computeMarketWideDates(
  returnsByTicker: { date: string; ret: number }[][],
  breadthMoveZ: number,
  breadthShare: number,
  minTickers = 20,
): Set<string> {
  const sharp = new Map<string, number>();
  const total = new Map<string, number>();
  for (const series of returnsByTicker) {
    const sigma = robustSigma(series.map((s) => s.ret));
    if (!(sigma > 0)) continue;
    for (const { date, ret } of series) {
      total.set(date, (total.get(date) ?? 0) + 1);
      if (Math.abs(ret) / sigma >= breadthMoveZ) sharp.set(date, (sharp.get(date) ?? 0) + 1);
    }
  }
  const wide = new Set<string>();
  for (const [date, n] of total) {
    if (n >= minTickers && (sharp.get(date) ?? 0) / n >= breadthShare) wide.add(date);
  }
  return wide;
}
