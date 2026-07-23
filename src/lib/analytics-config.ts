/**
 * Central configuration for the analytics layer. Every threshold the v6 spec
 * mentions lives here with its default — never hardcoded inside computation
 * logic. Loaded from the AnalyticsConfig DB row (single-operator tool) with
 * these values as fallback.
 */
import { tryDb } from './db';

export interface AnalyticsConfig {
  /** Sectors with fewer finalized constituents than this yield a null median. */
  minConstituents: number;
  /** 30-vs-90-day baseline detachment threshold, in units of the 90-day stdev. */
  regimeDetachSigma: number;
  /** Rolling-window lengths (finalized trading days) for the relative-spread z-scores. */
  z30Window: number;
  z90Window: number;
  /** Earnings exclusion window around a detected catalyst date (calendar days). */
  earningsWindowBeforeDays: number;
  earningsWindowAfterDays: number;
  /** ET minutes after the session close before the EOD capture fires. */
  captureDelayMin: number;
  /** Width of the EOD capture window (minutes). */
  captureWindowMin: number;
  /** Minimum finalized observations before a z-score is emitted (else null). */
  zMinObs30: number;
  zMinObs90: number;
  /** Floor on the rolling-window stdev denominator, preventing z blowups. */
  zStdevFloor: number;
  /** Median-membership liquidity floors (0 = disabled). */
  medianMinOI: number;
  medianMinVolume: number;
  /** IV outlier fence: exclude names beyond ±mult·IQR of the sector IV distribution. */
  medianIqrMult: number;
  /** Divergence trend window (finalized days) and the nonflat t-stat threshold. */
  divergenceWindow: number;
  divergenceTStat: number;
  /** Rich/cheap gauge: min CONFIRMED events (with realized moves) before it displays. */
  minConfirmedEvents: number;
  /** Event expiry-pair liquidity floor: min ATM OI, max ATM quote-width fraction. */
  eventMinOI: number;
  eventMaxQuoteWidth: number;
  /** Idiosyncratic-move detection (vs SPY): residual-z threshold, min raw move, regression window. */
  inferMoveZ: number;
  inferMinMovePct: number;
  inferBetaWindow: number;
  /** Market-wide-day filter: per-ticker sharp threshold (σ) and universe share. */
  breadthMoveZ: number;
  breadthShare: number;
  /** SEC EDGAR: priority tickers to backfill, quarterly-spacing floor, cache TTL. */
  edgarTickers: string[];
  edgarMinSpacingDays: number;
  edgarCacheTtlHours: number;
  /** Regime classification: per-dimension deadbands and persistence (days beyond band). */
  regimeVolDeadband: number;
  regimeTrendDeadbandPct: number;
  regimeGammaDeadbandFrac: number;
  regimePersistDays: number;
  /** Signal-grid thresholds (hashed into thresholdVersion). pcHigh/pcLow are OI-based;
   *  a volume-based P/C signal would be a NEW signal type, not a reuse. */
  skewZExtreme: number;
  pcHigh: number;
  pcLow: number;
  /** Matrix display: min cell sample; min in-regime ticker-days before ticker base rate. */
  minCellSample: number;
  baseRateMinTickerDays: number;
}

export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  minConstituents: 5,
  regimeDetachSigma: 1.0,
  z30Window: 30,
  z90Window: 90,
  earningsWindowBeforeDays: 7,
  earningsWindowAfterDays: 1,
  captureDelayMin: 20,
  captureWindowMin: 30,
  zMinObs30: 20,
  zMinObs90: 60,
  zStdevFloor: 0.1,
  medianMinOI: 0,
  medianMinVolume: 0,
  medianIqrMult: 2.5,
  divergenceWindow: 20,
  divergenceTStat: 1.5,
  minConfirmedEvents: 8,
  eventMinOI: 100,
  eventMaxQuoteWidth: 0.25,
  inferMoveZ: 3.5,
  inferMinMovePct: 0.02,
  inferBetaWindow: 60,
  breadthMoveZ: 3.0,
  breadthShare: 0.5,
  edgarTickers: [],
  edgarMinSpacingDays: 45,
  edgarCacheTtlHours: 168,
  regimeVolDeadband: 0.5,
  regimeTrendDeadbandPct: 0.005,
  regimeGammaDeadbandFrac: 0.1,
  regimePersistDays: 2,
  skewZExtreme: 2.0,
  pcHigh: 1.3,
  pcLow: 0.7,
  minCellSample: 20,
  baseRateMinTickerDays: 60,
};

let cached: AnalyticsConfig | null = null;

export async function getAnalyticsConfig(): Promise<AnalyticsConfig> {
  if (cached) return cached;
  const row = await tryDb('load analytics config', (db) => db.analyticsConfig.findUnique({ where: { id: 1 } }));
  cached = row
    ? {
        minConstituents: row.minConstituents,
        regimeDetachSigma: row.regimeDetachSigma,
        z30Window: row.z30Window,
        z90Window: row.z90Window,
        earningsWindowBeforeDays: row.earningsWindowBeforeDays,
        earningsWindowAfterDays: row.earningsWindowAfterDays,
        captureDelayMin: row.captureDelayMin,
        captureWindowMin: row.captureWindowMin,
        zMinObs30: row.zMinObs30,
        zMinObs90: row.zMinObs90,
        zStdevFloor: row.zStdevFloor,
        medianMinOI: row.medianMinOI,
        medianMinVolume: row.medianMinVolume,
        medianIqrMult: row.medianIqrMult,
        divergenceWindow: row.divergenceWindow,
        divergenceTStat: row.divergenceTStat,
        minConfirmedEvents: row.minConfirmedEvents,
        eventMinOI: row.eventMinOI,
        eventMaxQuoteWidth: row.eventMaxQuoteWidth,
        inferMoveZ: row.inferMoveZ,
        inferMinMovePct: row.inferMinMovePct,
        inferBetaWindow: row.inferBetaWindow,
        breadthMoveZ: row.breadthMoveZ,
        breadthShare: row.breadthShare,
        edgarTickers: row.edgarTickers,
        edgarMinSpacingDays: row.edgarMinSpacingDays,
        edgarCacheTtlHours: row.edgarCacheTtlHours,
        regimeVolDeadband: row.regimeVolDeadband,
        regimeTrendDeadbandPct: row.regimeTrendDeadbandPct,
        regimeGammaDeadbandFrac: row.regimeGammaDeadbandFrac,
        regimePersistDays: row.regimePersistDays,
        skewZExtreme: row.skewZExtreme,
        pcHigh: row.pcHigh,
        pcLow: row.pcLow,
        minCellSample: row.minCellSample,
        baseRateMinTickerDays: row.baseRateMinTickerDays,
      }
    : { ...DEFAULT_ANALYTICS_CONFIG };
  return cached;
}

export function invalidateAnalyticsConfig(): void {
  cached = null;
}
