/**
 * FlowEngine — the in-memory source of truth for live state.
 *
 * The poller feeds it cumulative session snapshots per ticker; the engine
 * derives per-cycle deltas, maintains rolling 5-minute windows, 30-minute
 * ratio sparklines, aggregate/sector ratios and the intraday ratio series,
 * and runs spike detection. API routes and the socket layer only read from it.
 *
 * A single instance lives on globalThis so the custom server, Next.js API
 * routes and dev-mode HMR all share state within the one process.
 */
import type {
  AggregateRatio,
  AppSettings,
  ConnectionStatus,
  DataSourceMode,
  MarketContext,
  RatioPoint,
  SectorRatio,
  SpikeAlert,
  TickerFlow,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { computeChainAnalytics } from './chain-analytics';
import { apiStats } from './data-source';
import type { OptionsChainAggregate } from './provider';
import { aggregateRatio, percentileRank, putCallRatio, sectorRatios } from './ratio-calculator';
import { SpikeDetector } from './spike-detector';
import { sectorOf } from './universe';
import { isMarketHours } from './utils';

const ROLLING_WINDOW_MS = 5 * 60_000;
const SPARKLINE_POINTS = 30; // 1-min resolution, 30 minutes
const MAX_ALERTS = 200;
const RATIO_SERIES_MAX = 500;

interface Sample {
  t: number;
  putVolume: number;
  callVolume: number;
  putPremium: number;
  callPremium: number;
}

interface TickerState {
  /** Last cumulative snapshot, for delta derivation. */
  cumulative: OptionsChainAggregate | null;
  /** Per-cycle deltas inside the rolling window. */
  samples: Sample[];
  sparkline: { t: number; ratio: number }[];
  flow: TickerFlow;
}

export type AlertListener = (alert: SpikeAlert) => void;

/** History-derived vol context per ticker, refreshed by the maintenance job. */
export interface VolContext {
  ivRank: number | null;
  hv20: number | null;
  /** Yesterday's total OI, for day-over-day OI change. */
  prevTotalOI: number | null;
}

export class FlowEngine {
  private tickers = new Map<string, TickerState>();
  private alerts: SpikeAlert[] = [];
  private ratioSeries: RatioPoint[] = [];
  private lastAggregate: AggregateRatio | null = null;
  private sectors: SectorRatio[] = [];
  private alertListeners = new Set<AlertListener>();
  private alertSeq = 0;

  readonly detector = new SpikeDetector();
  readonly volContext = new Map<string, VolContext>();
  marketContext: MarketContext | null = null;
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  mode: DataSourceMode = 'simulated';
  lastPollAt = 0;
  dbConnected = false;
  /** 20-day aggregate-ratio history for percentile ranking (loaded from DB). */
  historicalRatios: number[] = [];

  /** Ingest a fresh cumulative snapshot for one ticker. Returns the updated row. */
  ingest(agg: OptionsChainAggregate, now = Date.now()): TickerFlow {
    const st = this.tickers.get(agg.symbol) ?? this.initTicker(agg.symbol);

    // Delta vs previous cumulative snapshot. Providers report day volumes
    // that only grow intraday; a drop means a new session started.
    const prev = st.cumulative;
    const newSession = prev !== null && agg.putVolume + agg.callVolume < prev.putVolume + prev.callVolume;
    const base = newSession || prev === null ? null : prev;
    const sample: Sample = {
      t: now,
      putVolume: Math.max(0, agg.putVolume - (base?.putVolume ?? 0)),
      callVolume: Math.max(0, agg.callVolume - (base?.callVolume ?? 0)),
      putPremium: Math.max(0, agg.putPremium - (base?.putPremium ?? 0)),
      callPremium: Math.max(0, agg.callPremium - (base?.callPremium ?? 0)),
    };
    st.cumulative = agg;
    if (newSession) st.samples = [];
    st.samples.push(sample);
    const cutoff = now - ROLLING_WINDOW_MS;
    st.samples = st.samples.filter((s) => s.t > cutoff);

    let putVolume = 0;
    let callVolume = 0;
    let putPremium = 0;
    let callPremium = 0;
    for (const s of st.samples) {
      putVolume += s.putVolume;
      callVolume += s.callVolume;
      putPremium += s.putPremium;
      callPremium += s.callPremium;
    }

    // Rolling-window ratio when there's flow; otherwise session ratio.
    const windowHasFlow = putVolume + callVolume > 0;
    const ratio = windowHasFlow
      ? putCallRatio(putVolume, callVolume)
      : putCallRatio(agg.putVolume, agg.callVolume);

    // Sparkline: one point per minute.
    const lastPoint = st.sparkline[st.sparkline.length - 1];
    if (!lastPoint || now - lastPoint.t >= 60_000) {
      st.sparkline.push({ t: now, ratio });
      if (st.sparkline.length > SPARKLINE_POINTS) st.sparkline.shift();
    } else {
      lastPoint.ratio = ratio;
    }

    const spike = this.detector.evaluate(
      {
        symbol: agg.symbol,
        sessionVolume: agg.putVolume + agg.callVolume,
        rollingPremium: putPremium + callPremium,
        rollingContracts: putVolume + callVolume,
        putCallRatio: ratio,
        largestContractVolume: agg.largestContractVolume,
      },
      this.settings,
    );

    // Chain analytics: simulator supplies them; live providers pass contracts.
    const analytics =
      agg.analytics ??
      (agg.contracts && agg.contracts.length > 0
        ? computeChainAnalytics(agg.contracts, agg.underlyingPrice, now)
        : null);
    const ctx = this.volContext.get(agg.symbol);
    const totalOI = analytics ? analytics.putOI + analytics.callOI : 0;
    const oiChangePct =
      ctx?.prevTotalOI && ctx.prevTotalOI > 0 && totalOI > 0
        ? Number((((totalOI - ctx.prevTotalOI) / ctx.prevTotalOI) * 100).toFixed(2))
        : null;

    const netFlow = callVolume - putVolume;
    st.flow = {
      symbol: agg.symbol,
      sector: sectorOf(agg.symbol),
      putVolume,
      callVolume,
      sessionPutVolume: agg.putVolume,
      sessionCallVolume: agg.callVolume,
      putCallRatio: ratio,
      netFlow,
      callPremium,
      putPremium,
      spikeLevel: spike.level,
      spikeScore: spike.score,
      volumeVsExpected: spike.volumeMultiple,
      ratioSparkline: st.sparkline.map((p) => Number(p.ratio.toFixed(3))),
      underlyingPrice: agg.underlyingPrice,
      priceChangePct: agg.priceChangePct,
      iv30: agg.iv30,
      iv30Change: agg.iv30Change,
      ivRank: ctx?.ivRank ?? analytics?.ivRank ?? null,
      hv20: ctx?.hv20 ?? analytics?.hv20 ?? null,
      oiChangePct,
      analytics,
      lastUpdated: now,
      lastDelta: netFlow > 0 ? 'bullish' : netFlow < 0 ? 'bearish' : 'none',
    };
    this.tickers.set(agg.symbol, st);

    if (spike.alertable && spike.consecutiveCycles === 2) {
      // Fire once when a spike is first confirmed, not on every cycle after.
      this.pushAlert({
        id: `a${now}-${this.alertSeq++}`,
        symbol: agg.symbol,
        level: spike.level === 'normal' ? 'elevated' : spike.level,
        message:
          `${agg.symbol} volume ${spike.volumeMultiple.toFixed(1)}× expected — ` +
          `${ratio > 1 ? 'put-heavy' : 'call-heavy'} (P/C ${ratio.toFixed(2)})` +
          (spike.isBlockTrade ? ' · block trade' : ''),
        volumeMultiple: Number(spike.volumeMultiple.toFixed(2)),
        premium: Math.round(putPremium + callPremium),
        contracts: putVolume + callVolume,
        putCallRatio: Number(ratio.toFixed(3)),
        createdAt: now,
      });
    }

    return st.flow;
  }

  /** Recompute aggregate + sector ratios; call once per completed poll cycle. */
  finalizeCycle(now = Date.now()): { aggregate: AggregateRatio; sectors: SectorRatio[]; point: RatioPoint } {
    const rows = this.allFlows();
    // Trend vs the ratio ~15 minutes ago.
    const ref = this.ratioSeries[Math.max(0, this.ratioSeries.length - 30)];
    const aggregate = aggregateRatio(rows, ref?.ratio ?? this.lastAggregate?.ratio ?? null, {
      mean:
        this.historicalRatios.length > 0
          ? this.historicalRatios.reduce((a, b) => a + b, 0) / this.historicalRatios.length
          : null,
      percentile: null,
    });
    aggregate.percentile = percentileRank(aggregate.ratio, this.historicalRatios);

    const spy = this.tickers.get('SPY')?.flow.underlyingPrice;
    const point: RatioPoint = {
      time: Math.floor(now / 1000),
      ratio: Number(aggregate.ratio.toFixed(4)),
      ...(spy && spy > 0 ? { spx: spy } : {}),
    };
    const last = this.ratioSeries[this.ratioSeries.length - 1];
    if (!last || point.time - last.time >= 30) {
      this.ratioSeries.push(point);
      if (this.ratioSeries.length > RATIO_SERIES_MAX) this.ratioSeries.shift();
    }

    this.lastAggregate = aggregate;
    this.sectors = sectorRatios(rows);
    this.lastPollAt = now;
    return { aggregate, sectors: this.sectors, point };
  }

  allFlows(): TickerFlow[] {
    return [...this.tickers.values()].map((t) => t.flow);
  }

  getFlow(symbol: string): TickerFlow | null {
    return this.tickers.get(symbol)?.flow ?? null;
  }

  getAggregate(): AggregateRatio | null {
    return this.lastAggregate;
  }

  getSectors(): SectorRatio[] {
    return this.sectors;
  }

  getRatioSeries(): RatioPoint[] {
    return this.ratioSeries;
  }

  getAlerts(limit = 50): SpikeAlert[] {
    return this.alerts.slice(0, limit);
  }

  onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  status(): ConnectionStatus {
    const api = apiStats();
    return {
      healthy: Date.now() - this.lastPollAt < 120_000,
      mode: this.mode,
      provider: api.provider,
      lastPollAt: this.lastPollAt,
      tickersTracked: this.tickers.size,
      apiCallsLastMinute: api.callsLastMinute,
      rateLimitPerMinute: api.perMinute,
      dbConnected: this.dbConnected,
      marketOpen: isMarketHours(),
    };
  }

  private pushAlert(alert: SpikeAlert): void {
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.pop();
    for (const listener of this.alertListeners) listener(alert);
  }

  private initTicker(symbol: string): TickerState {
    return {
      cumulative: null,
      samples: [],
      sparkline: [],
      flow: {
        symbol,
        sector: sectorOf(symbol),
        putVolume: 0,
        callVolume: 0,
        sessionPutVolume: 0,
        sessionCallVolume: 0,
        putCallRatio: 1,
        netFlow: 0,
        callPremium: 0,
        putPremium: 0,
        spikeLevel: 'normal',
        spikeScore: 0,
        volumeVsExpected: 0,
        ratioSparkline: [],
        underlyingPrice: 0,
        priceChangePct: 0,
        iv30: null,
        iv30Change: null,
        ivRank: null,
        hv20: null,
        oiChangePct: null,
        analytics: null,
        lastUpdated: 0,
        lastDelta: 'none',
      },
    };
  }
}

const globalStore = globalThis as unknown as { __flowEngine?: FlowEngine };

export function getFlowEngine(): FlowEngine {
  if (!globalStore.__flowEngine) globalStore.__flowEngine = new FlowEngine();
  return globalStore.__flowEngine;
}
