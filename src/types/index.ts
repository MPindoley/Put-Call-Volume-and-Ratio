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

/** One row of the live flow table. Everything the client renders per ticker. */
export interface TickerFlow {
  symbol: string;
  sector: Sector;
  /** Rolling 5-minute put volume (contracts). */
  putVolume: number;
  /** Rolling 5-minute call volume (contracts). */
  callVolume: number;
  /** Session cumulative volumes. */
  sessionPutVolume: number;
  sessionCallVolume: number;
  /** put / call over the rolling window; falls back to session ratio. */
  putCallRatio: number;
  /** callVolume - putVolume over rolling window. */
  netFlow: number;
  /** Rolling 5-minute notional premium in USD. */
  callPremium: number;
  putPremium: number;
  spikeLevel: SpikeLevel;
  /** Composite 0–100 unusual-activity score. */
  spikeScore: number;
  /** Actual volume / expected volume for this time-of-day bucket. */
  volumeVsExpected: number;
  /** P/C ratio, one point per minute, last 30 minutes. */
  ratioSparkline: number[];
  underlyingPrice: number;
  priceChangePct: number;
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
  /** Epoch ms of last successful data refresh for this ticker. */
  lastUpdated: number;
  /** Direction of the most recent net-flow delta, used for row flashing. */
  lastDelta: 'bullish' | 'bearish' | 'none';
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

export interface ServerToClientEvents {
  'flow-update': (rows: TickerFlow[]) => void;
  'spike-alert': (alert: SpikeAlert) => void;
  'ratio-update': (
    agg: AggregateRatio,
    sectors: SectorRatio[],
    point: RatioPoint,
    market: MarketContext | null,
  ) => void;
  'connection-status': (status: ConnectionStatus) => void;
}

export interface ClientToServerEvents {
  'request-snapshot': () => void;
}
