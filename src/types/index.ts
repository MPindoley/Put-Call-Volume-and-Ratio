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
  'ratio-update': (agg: AggregateRatio, sectors: SectorRatio[], point: RatioPoint) => void;
  'connection-status': (status: ConnectionStatus) => void;
}

export interface ClientToServerEvents {
  'request-snapshot': () => void;
}
