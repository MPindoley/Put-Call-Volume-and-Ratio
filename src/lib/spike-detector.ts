/**
 * Volume spike detection.
 *
 * Expected volume for a ticker at time T = 20-day average daily options volume
 * × cumulative intraday profile weight at T. Actual session volume is compared
 * against that expectation; the multiple (scaled by global + per-ticker
 * sensitivity) maps to alert levels:
 *
 *   elevated    > 2× expected
 *   significant > 5× expected
 *   extreme     > 10× expected
 *
 * Noise filters: minimum premium (default $500K), minimum contract count, and
 * consecutive-cycle confirmation before an alert fires (sustained vs one-off).
 * When no stored 20-day baseline exists yet, the detector bootstraps an
 * adaptive baseline from the session itself (EMA), so it degrades gracefully
 * on first run / without a database.
 */
import type { AppSettings, SpikeLevel, TickerOverrideSettings } from '@/types';
import { tradingBucket } from './utils';

/**
 * Intraday options volume profile: share of the day's volume traded in each
 * 30-min bucket (U-shape — heavy open and close). Used until enough stored
 * history exists to compute per-ticker profiles.
 */
export const DEFAULT_INTRADAY_SHAPE = [
  0.14, 0.10, 0.08, 0.07, 0.06, 0.06, 0.06, 0.06, 0.07, 0.08, 0.09, 0.10, 0.03,
] as const;

export interface Baseline {
  avgDailyVolume: number;
  stdDevVolume: number;
  intradayShape: readonly number[];
  sampleDays: number;
}

export interface SpikeInput {
  symbol: string;
  /** Cumulative session volume (puts + calls). */
  sessionVolume: number;
  /** Rolling-window premium (puts + calls), USD. */
  rollingPremium: number;
  /** Rolling-window contract count. */
  rollingContracts: number;
  putCallRatio: number;
  /** Largest single contract's day volume — block/single-print heuristic. */
  largestContractVolume: number;
}

export interface SpikeResult {
  level: SpikeLevel;
  /** Actual / expected volume, after sensitivity scaling. */
  volumeMultiple: number;
  /** Composite 0–100 unusual-activity score. */
  score: number;
  /** True when the level cleared the noise filters and is alert-worthy. */
  alertable: boolean;
  isBlockTrade: boolean;
  consecutiveCycles: number;
}

const LEVEL_THRESHOLDS: [SpikeLevel, number][] = [
  ['extreme', 10],
  ['significant', 5],
  ['elevated', 2],
];

/** Cycles a level must persist before alerting (one-off print suppression). */
const CONFIRMATION_CYCLES = 2;
const BLOCK_TRADE_CONTRACTS = 500;

interface TickerState {
  emaVolume: number;
  samples: number;
  consecutive: number;
  lastLevel: SpikeLevel;
}

export class SpikeDetector {
  private baselines = new Map<string, Baseline>();
  private state = new Map<string, TickerState>();

  setBaseline(symbol: string, baseline: Baseline): void {
    this.baselines.set(symbol, baseline);
  }

  hasBaseline(symbol: string): boolean {
    return this.baselines.has(symbol);
  }

  /** Expected cumulative session volume for `symbol` right now. */
  expectedVolume(symbol: string, now = new Date()): number {
    const baseline = this.baselines.get(symbol);
    const shape = baseline?.intradayShape ?? DEFAULT_INTRADAY_SHAPE;
    const bucket = tradingBucket(now);
    let cumulative = 0;
    for (let i = 0; i <= bucket; i++) cumulative += shape[i] ?? 0;
    cumulative = Math.max(cumulative, shape[0] ?? 0.1);

    if (baseline && baseline.avgDailyVolume > 0) {
      return baseline.avgDailyVolume * cumulative;
    }
    // Bootstrap: adapt from what we've seen this session.
    const st = this.state.get(symbol);
    if (st && st.samples >= 3) return Math.max(st.emaVolume, 1);
    return 0; // unknown — treat as normal until we have signal
  }

  evaluate(input: SpikeInput, settings: AppSettings, now = new Date()): SpikeResult {
    const override: TickerOverrideSettings = settings.tickerOverrides[input.symbol] ?? {};
    const sensitivity = override.sensitivity ?? settings.sensitivity;
    const minPremium = override.minPremium ?? settings.minPremium;
    const minContracts = override.minContracts ?? settings.minContracts;

    const st = this.state.get(input.symbol) ?? {
      emaVolume: input.sessionVolume,
      samples: 0,
      consecutive: 0,
      lastLevel: 'normal' as SpikeLevel,
    };

    const expected = this.expectedVolume(input.symbol, now);
    // sensitivity > 1 = conservative (raises the bar), < 1 = aggressive.
    const rawMultiple = expected > 0 ? input.sessionVolume / expected : 0;
    const volumeMultiple = sensitivity > 0 ? rawMultiple / sensitivity : rawMultiple;

    let level: SpikeLevel = 'normal';
    for (const [lvl, threshold] of LEVEL_THRESHOLDS) {
      if (volumeMultiple >= threshold) {
        level = lvl;
        break;
      }
    }

    // Single-print filter: a "spike" made of one contract's volume with no
    // breadth is likely one block crossing — flag it but demote severity.
    const isBlockTrade = input.largestContractVolume >= BLOCK_TRADE_CONTRACTS;
    const singlePrintDominates =
      input.sessionVolume > 0 && input.largestContractVolume / input.sessionVolume > 0.8;
    if (level !== 'normal' && singlePrintDominates && level === 'extreme') {
      level = 'significant';
    }

    st.consecutive = level !== 'normal' && st.lastLevel !== 'normal' ? st.consecutive + 1 : level !== 'normal' ? 1 : 0;
    st.lastLevel = level;
    // Session EMA baseline bootstrap (slow: spikes shouldn't drag it up fast).
    st.emaVolume = st.samples === 0 ? input.sessionVolume : st.emaVolume * 0.9 + input.sessionVolume * 0.1;
    st.samples += 1;
    this.state.set(input.symbol, st);

    const passesFilters =
      input.rollingPremium >= minPremium &&
      input.rollingContracts >= minContracts &&
      !(override.muted ?? false);

    const alertable = level !== 'normal' && passesFilters && st.consecutive >= CONFIRMATION_CYCLES;

    return {
      level,
      volumeMultiple: rawMultiple,
      score: this.compositeScore(input, volumeMultiple),
      alertable,
      isBlockTrade,
      consecutiveCycles: st.consecutive,
    };
  }

  /**
   * Unusual-activity score 0–100:
   *   55% volume anomaly, 25% premium size, 20% ratio extremity.
   */
  private compositeScore(input: SpikeInput, volumeMultiple: number): number {
    const volScore = Math.min(1, volumeMultiple / 10); // saturates at 10×
    const premScore = Math.min(1, input.rollingPremium / 5_000_000); // $5M saturates
    const ratioExtremity = Math.min(1, Math.abs(Math.log(Math.max(input.putCallRatio, 0.01))) / Math.log(5));
    const score = volScore * 55 + premScore * 25 + ratioExtremity * 20;
    return Math.round(Math.min(100, Math.max(0, score)));
  }
}

/** Compute a 20-day baseline from stored daily volume totals. */
export function computeBaseline(dailyVolumes: number[], intradayShape?: number[]): Baseline {
  const n = dailyVolumes.length;
  if (n === 0) {
    return { avgDailyVolume: 0, stdDevVolume: 0, intradayShape: DEFAULT_INTRADAY_SHAPE, sampleDays: 0 };
  }
  const avg = dailyVolumes.reduce((a, b) => a + b, 0) / n;
  const variance = dailyVolumes.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  return {
    avgDailyVolume: avg,
    stdDevVolume: Math.sqrt(variance),
    intradayShape: intradayShape && intradayShape.length === 13 ? intradayShape : DEFAULT_INTRADAY_SHAPE,
    sampleDays: n,
  };
}
