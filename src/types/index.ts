// ─── Shared domain types ──────────────────────────────────────────────────────

export type SpikeLevel = 'normal' | 'elevated' | 'significant' | 'extreme';

export type Sector =
  | 'Technology'
  | 'Financials'
  | 'Healthcare'
  | 'Consumer Discretionary'
  | 'Consumer Staples'
  | 'Energy'
  | 'Industrials'
  | 'Materials'
  | 'Utilities'
  | 'Real Estate'
  | 'Communication Services'
  | 'ETF'
  | 'Unknown';

/** One raw option contract, normalized across providers. */
export interface RawContract {
  type: 'call' | 'put';
  strike: number;
  /** Expiration as epoch ms (UTC midnight). */
  expiration: number;
  /** Implied volatility as a decimal (0.25 = 25%). */
  iv: number;
  delta: number;
  gamma: number;
  openInterest: number;
  volume: number;
  /** Mid price (bid/ask midpoint, falling back to last trade). */
  mid: number;
  /** Bid/ask when the provider supplies them — used for the event quote-width gate. */
  bid?: number;
  ask?: number;
}

/** Derived per-chain analytics: skew, term structure, OI, dealer gamma. */
export interface ChainAnalytics {
  /** 25-delta risk reversal in vol points: IV(25Δ call) − IV(25Δ put). Negative = normal put skew. */
  rrSkew25: number | null;
  /** ATM IV (vol points) at the ~30-day and ~90-day expirations. */
  atmIvNear: number | null;
  atmIvFar: number | null;
  /** far − near; negative = backwardation (near-term fear/event). */
  termSlope: number | null;
  backwardated: boolean;
  /** Expiration date (ISO) with an IV bulge vs neighbors — likely catalyst date. */
  eventExpiry: string | null;
  /** ATM straddle of the nearest expiry as % of spot. */
  impliedMovePct: number | null;
  putOI: number;
  callOI: number;
  /** put OI / call OI (positioning, slower than volume P/C). */
  oiPutCall: number | null;
  /** Strike minimizing option-holder payout at the nearest monthly expiry. */
  maxPain: number | null;
  topStrikes: { strike: number; putOI: number; callOI: number }[];
  /** Naive dealer gamma exposure: $ notional per 1% underlying move (calls +, puts −). */
  gexPer1Pct: number | null;
  /** ATM IV of the longest-dated (LEAP) expiry, vol points. */
  leapIv: number | null;
  /** Simulator-only prefills; live values come from stored history. */
  ivRank?: number | null;
  hv20?: number | null;
}

/** Market-wide volatility context shown in the ratio panel. */
export interface MarketContext {
  vix: number | null;
  vix3m: number | null;
  /** vix3m − vix; negative = backwardation (stress). */
  vixSpread: number | null;
  updatedAt: number;
}

/**
 * Per-ticker sector-relative z-scores (Phase 1). Each is the ticker's
 * (value − sector median) spread expressed as a z-score against its own
 * finalized 30/90-day rolling history. Null while accumulating.
 */
/**
 * Learned conviction for one ticker: its signals from the latest finalized
 * session, each weighted by how well that signal has actually worked (hit rate
 * above the regime-matched base rate, shrunk toward zero on thin evidence).
 */
export interface TickerConviction {
  /** Signed lean in hit-rate points above base (+ bullish, − bearish); 0.04 = 4 points. */
  score: number;
  /** Null when the net is too small to be worth showing. */
  direction: 'bullish' | 'bearish' | null;
  /** ET session the signals fired on (the edge book's asOf). */
  asOf: string;
  parts: { signalType: string; direction: 'bullish' | 'bearish'; edge: number; n: number }[];
}

export interface SectorRelative {
  symbol: string;
  /** The peer cohort this name is measured against (benchmark ETF key + label). */
  cohort: string | null;
  cohortLabel: string | null;
  skewZ30: number | null;
  skewZ90: number | null;
  ivZ30: number | null;
  ivZ90: number | null;
  oiPcZ30: number | null;
  oiPcZ90: number | null;
  ivHvZ30: number | null;
  ivHvZ90: number | null;
  /** Finalized rows available in the 90-day window (for "accumulating N/90"). */
  windowDays: number;
  regimeDetach: boolean;
  regimeDetachMetric: string | null;
  regimeDetachDir: string | null;
  /** Phase 2 divergence (inverse-adjusted to underlying exposure), or null. */
  divergence: 'distribution' | 'accumulation' | null;
  /** Skew-z points available for the divergence trend, and whether still warming. */
  divergenceWindow: number;
  /** OLS trend t-stats (the heuristic screen) and their Newey-West HAC audit values. */
  priceTrendT: number | null;
  skewTrendT: number | null;
  priceTrendTNW: number | null;
  skewTrendTNW: number | null;
}

/**
 * Per-COHORT IV-dispersion proxy + median health. A cohort is a peer group
 * keyed by its benchmark ETF (GICS SPDR, or an industry ETF for overridden
 * names like semis→SMH). `constituentCount` and `medianIqr` are the
 * median-health signals (did a name's spread move, or did the cohort shift?).
 */
export interface SectorDispersion {
  cohort: string;
  label: string;
  proxy: number | null;
  /** Weighting stamped on this value: 'cap' | 'oi' | 'equal'. */
  weightMethod: string | null;
  /** Current value's percentile within its own same-version 90-day series. */
  pct90: number | null;
  sampleDays: number;
  constituentCount: number;
  /** Interquartile range of member IV30 — cohort dispersion of the peer set. */
  medianIqr: number | null;
  /** Composition-definition version; a change resets the rolling windows. */
  compositionVersion: string;
}

/** IV-direction OI tiebreaker classification for one side (call or put). */
export type OiSignal = 'demand' | 'supply' | 'unwind' | 'short-cover' | null;

export interface SideFlow {
  /** Day-over-day OI change for this side, %. */
  oiChangePct: number | null;
  /** Decomposed day IV change for this side (vol points). */
  ivChange: number | null;
  signal: OiSignal;
}

/** One row of the live flow table. Everything the client renders per ticker. */
export interface TickerFlow {
  symbol: string;
  sector: Sector;
  /**
   * Put / call contracts per 5 minutes, measured over the most recent data
   * (flow-window.ts): a rate, so names refreshed at different speeds compare.
   */
  putVolume: number;
  callVolume: number;
  /** Session cumulative volumes. */
  sessionPutVolume: number;
  sessionCallVolume: number;
  /** put / call over the measured window; falls back to the session ratio. */
  putCallRatio: number;
  /** callVolume − putVolume (per 5 minutes). */
  netFlow: number;
  /** Notional premium per 5 minutes, USD. */
  callPremium: number;
  putPremium: number;
  spikeLevel: SpikeLevel;
  /** Composite 0–100 unusual-activity score. */
  spikeScore: number;
  /** Actual volume / expected volume for this time-of-day bucket. */
  volumeVsExpected: number;
  /** P/C ratio, one point per minute, last 30 minutes. */
  ratioSparkline: number[];
  /** Price from the option-chain snapshot — 15-minute delayed, like the chain. */
  underlyingPrice: number;
  priceChangePct: number;
  /**
   * Live last-trade price from the quote sweep, independent of the chain
   * rotation. Null until the first sweep lands (never back-filled from the
   * delayed price, so "live" always means live). `livePriceAt` is the venue
   * trade time in ms, for ageing the quote in the UI.
   */
  livePrice: number | null;
  livePriceChangePct: number | null;
  livePriceAt: number | null;
  /** 30-day implied volatility (vol points, e.g. 27.1) and day change. */
  iv30: number | null;
  iv30Change: number | null;
  /** Percentile of current IV30 within stored history (matures toward 52wk). */
  ivRank: number | null;
  /** 20-day realized volatility of the underlying (vol points). */
  hv20: number | null;
  /** Day-over-day change in total open interest, %. */
  oiChangePct: number | null;
  analytics: ChainAnalytics | null;
  /** Inverse product (interpretation flips to underlying exposure) + leverage. */
  inverse: boolean;
  leverage: number;
  /**
   * IV-direction OI tiebreaker per side (demand/supply/unwind/short-cover),
   * plus the RAW shared inputs (underlying IV30 day-change and skew day-change)
   * used to decompose per-side IV — surfaced so thin decompositions (large
   * |skewChange| relative to |iv30Change|) can be audited.
   */
  oiSignals: { call: SideFlow; put: SideFlow; iv30Change: number | null; skewChange: number | null } | null;
  /** Sector-relative z-scores; null until the EOD capture has run with history. */
  sectorRelative: SectorRelative | null;
  /**
   * What the app has LEARNED about this name's signals from the latest session
   * (the edge book, src/lib/learning.ts). Null when no signal fired that session.
   */
  conviction: TickerConviction | null;
  /** Earnings/event implied-move + rich/cheap gauge; null until events exist. */
  eventGauge: EventGauge | null;
  /** Recent large unscheduled single-name moves (idiosyncratic feed); newest first. */
  idiosyncraticMoves: IdiosyncraticMove[];
  /** Epoch ms this ticker was last fetched. */
  lastUpdated: number;
  /**
   * Epoch ms of the market moment the data reflects (0 = no data yet). With the
   * free feed this trails the fetch by its 15-minute delay, and more when the
   * provider hands back an older snapshot — the honest "as of" for every
   * chain-derived number in the row.
   */
  dataAsOf: number;
  /** Data time the 5-minute figures were measured over (ms), or null when there is too little yet. */
  flowWindowMs: number | null;
  /** Direction of the most recent net-flow delta, used for row flashing. */
  lastDelta: 'bullish' | 'bearish' | 'none';
}

/** Provenance of the active catalyst: confirmed calendar sources, or an unconfirmed live bulge. */
export type EventSource = 'manual' | 'forward' | 'bulge';
export type ReportTiming = 'bmo' | 'amc' | 'unknown';

/**
 * Per-ticker earnings/event surface: the live two-expiry implied event move plus
 * the rich/cheap gauge that ranks it against the realized-move distribution of
 * CONFIRMED events (manual + forward-confirmed) only. The gauge stays suppressed
 * (`display=false`) until a ticker has enough confirmed events — a plain
 * "insufficient confirmed history" state, not a number. Inferred price moves never
 * feed this; they live in the separate idiosyncratic feed.
 */
export interface EventGauge {
  /** Active catalyst date (ET ISO) the implied move is measured to, if any. */
  eventDate: string | null;
  eventSource: EventSource | null;
  reportTiming: ReportTiming | null;
  /** Live implied one-session event move as a fraction of spot (sqrt(v_e)). */
  impliedMove: number | null;
  impliedMethod: 'pre-event-reference' | 'two-post-event' | null;
  /** Clean diffusive vol (decimal annualized) backed out alongside the event move. */
  diffusiveVol: number | null;
  /** Why the decomposition refused (guardrail 1/3), surfaced rather than hidden. */
  refusedReason: string | null;
  /** True once ≥requiredCount confirmed events with realized moves exist. */
  display: boolean;
  confirmedCount: number;
  requiredCount: number;
  /** Median confirmed realized move (fraction). */
  medianRealized: number | null;
  /** Implied move's percentile in the confirmed realized distribution (0–100). */
  percentile: number | null;
  /** implied ÷ median realized: >1 rich, <1 cheap. */
  richCheapRatio: number | null;
}

/** One large unscheduled single-name move (the idiosyncratic-event feed). */
export interface IdiosyncraticMove {
  date: string;
  /** Total single-session move magnitude, as a fraction of spot. */
  movePct: number;
  /** Residual (benchmark-adjusted) magnitude in robust sigmas. */
  residualZ: number;
}

export interface SpikeAlert {
  id: string;
  symbol: string;
  level: Exclude<SpikeLevel, 'normal'>;
  message: string;
  volumeMultiple: number;
  premium: number;
  contracts: number;
  putCallRatio: number;
  createdAt: number;
}

export interface AggregateRatio {
  ratio: number;
  putVolume: number;
  callVolume: number;
  /** Single-name-only P/C (retail sentiment gauge, per GICS sectors). */
  equityRatio: number | null;
  /** ETF/index-only P/C (dominated by institutional hedging). */
  etfRatio: number | null;
  /** Signed change vs ~15 minutes ago (positive = ratio rising = bearish drift). */
  trend: number;
  /** Ratio vs 20-day mean, as percentile 0–100 when history exists. */
  percentile: number | null;
  vs20DayAvg: number | null;
  timestamp: number;
}

export interface RatioPoint {
  /** Epoch seconds (Lightweight Charts convention). */
  time: number;
  ratio: number;
  spx?: number;
}

export interface SectorRatio {
  sector: Sector;
  ratio: number;
  putVolume: number;
  callVolume: number;
  tickerCount: number;
}

export type DataSourceMode = 'live' | 'simulated';

export interface ConnectionStatus {
  healthy: boolean;
  mode: DataSourceMode;
  /** Which data source is feeding the engine: 'massive' | 'cboe' | 'simulator'. */
  provider: string;
  /** Epoch ms of last completed poll cycle. */
  lastPollAt: number;
  tickersTracked: number;
  apiCallsLastMinute: number;
  rateLimitPerMinute: number;
  dbConnected: boolean;
  marketOpen: boolean;
}

export interface AppSettings {
  /** Global spike sensitivity multiplier, 0.5 (aggressive) → 3.0 (conservative). */
  sensitivity: number;
  /** Only alert when rolling premium exceeds this (USD). */
  minPremium: number;
  minContracts: number;
  updateFrequencySec: number;
  soundEnabled: boolean;
  timezone: string;
  hiddenColumns: string[];
  watchlist: string[];
  tickerOverrides: Record<string, TickerOverrideSettings>;
}

export interface TickerOverrideSettings {
  sensitivity?: number;
  minPremium?: number;
  minContracts?: number;
  muted?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sensitivity: 1.0,
  minPremium: 500_000,
  minContracts: 100,
  updateFrequencySec: 30,
  soundEnabled: false,
  timezone: 'America/New_York',
  hiddenColumns: [],
  watchlist: ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'],
  tickerOverrides: {},
};

// ─── Socket.io event payloads ─────────────────────────────────────────────────

/** A live price for one symbol: [symbol, price, % change vs prior close, venue trade time ms]. */
export type QuoteTick = [symbol: string, price: number, changePct: number | null, at: number];

export interface ServerToClientEvents {
  'flow-update': (rows: TickerFlow[]) => void;
  /**
   * Live-price sweep results. Deliberately NOT full rows: a sweep touches most
   * of the universe every minute, and resending every row (~3 KB each) to move
   * one price field was ~70× the bytes of these tuples.
   */
  'quote-update': (ticks: QuoteTick[]) => void;
  'spike-alert': (alert: SpikeAlert) => void;
  'ratio-update': (
    agg: AggregateRatio,
    sectors: SectorRatio[],
    point: RatioPoint,
    market: MarketContext | null,
    dispersions: SectorDispersion[],
  ) => void;
  'connection-status': (status: ConnectionStatus) => void;
}

export interface ClientToServerEvents {
  'request-snapshot': () => void;
}
