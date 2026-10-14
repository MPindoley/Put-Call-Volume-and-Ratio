/**
 * FlowEngine — the in-memory source of truth for live state.
 *
 * The poller feeds it cumulative session snapshots per ticker; the engine
 * derives deltas between snapshots, timed by each snapshot's DATA time
 * (flow-window.ts), turns them into per-5-minute rates, keeps 30-minute ratio
 * sparklines, aggregate/sector ratios and the intraday ratio series, and runs
 * spike detection. API routes and the socket layer only read from it.
 *
 * A single instance lives on globalThis so the custom server, Next.js API
 * routes and dev-mode HMR all share state within the one process.
 */
import type {
  AggregateRatio,
  AppSettings,
  ConnectionStatus,
  DataSourceMode,
  IdiosyncraticMove,
  MarketContext,
  RatioPoint,
  SectorDispersion,
  SectorRatio,
  SectorRelative,
  SideFlow,
  SpikeAlert,
  TickerConviction,
  TickerFlow,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { computeChainAnalytics } from './chain-analytics';
import { MIN_COVERAGE_MS, pruneIntervals, windowFlow, type FlowInterval } from './flow-window';
import { buildEventGauge, type EventGaugeInput } from './event-analytics';
import { classifyOiFlow, defaultInstrument, sideIvChanges, type InstrumentConfig } from './interpretation';
import { apiStats } from './data-source';
import type { OptionsChainAggregate } from './provider';
import { aggregateRatio, percentileRank, putCallRatio, sectorRatios } from './ratio-calculator';
import { SpikeDetector } from './spike-detector';
import { etDateKey, isTradingDayNow } from './trading-calendar';
import { sectorOf } from './universe';
import { isMarketHours } from './utils';

const SPARKLINE_POINTS = 30; // 1-min resolution, 30 minutes
const MAX_ALERTS = 200;
const RATIO_SERIES_MAX = 500;

interface TickerState {
  /**
   * Last cumulative snapshot, for delta derivation. Stored WITHOUT its contract
   * list: only the totals are needed, and holding every chain's contracts for
   * the whole universe costs hundreds of MB of RAM for nothing.
   */
  cumulative: OptionsChainAggregate | null;
  /** Data time of `cumulative` (epoch ms). */
  cumulativeAt: number;
  /** Deltas between successive snapshots, on the data clock (ascending). */
  intervals: FlowInterval[];
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
  /** Yesterday's per-side OI and skew, for the IV-direction OI tiebreaker. */
  prevPutOI: number | null;
  prevCallOI: number | null;
  prevRrSkew: number | null;
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
  /** Per-ticker sector-relative z-scores, refreshed at the EOD capture. */
  readonly sectorRelatives = new Map<string, SectorRelative>();
  /** Per-sector IV-dispersion proxy, refreshed at the EOD capture. */
  readonly sectorDispersion = new Map<string, SectorDispersion>();
  /** Per-ticker inverse/leverage config for the interpretation layer. */
  readonly instruments = new Map<string, InstrumentConfig>();
  /** Per-ticker event-gauge inputs (active catalyst + realized distribution), refreshed periodically. */
  readonly eventInputs = new Map<string, EventGaugeInput>();
  /** Per-ticker recent idiosyncratic moves (unscheduled single-name), refreshed periodically. */
  readonly idiosyncraticMoves = new Map<string, IdiosyncraticMove[]>();
  /** Per-ticker learned conviction from the latest edge book (learning-jobs.ts). */
  readonly convictions = new Map<string, TickerConviction>();
  marketContext: MarketContext | null = null;
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  mode: DataSourceMode = 'simulated';
  lastPollAt = 0;
  dbConnected = false;
  /** 20-day aggregate-ratio history for percentile ranking (loaded from DB). */
  historicalRatios: number[] = [];

  /**
   * Ingest a cumulative snapshot for one ticker. Returns the updated row.
   *
   * `now` is when it was fetched; `agg.asOf` is the market moment it reflects
   * (a delayed feed lags the fetch, and a CDN can hand back a snapshot that is
   * older still). All flow timing uses the data time. A snapshot no newer than
   * the last one carries no new information and is not counted again — it
   * would otherwise log a zero-volume interval (a false lull) and count as a
   * second confirming cycle for a spike that never re-occurred.
   */
  ingest(agg: OptionsChainAggregate, now = Date.now()): TickerFlow {
    const st = this.tickers.get(agg.symbol) ?? this.initTicker(agg.symbol);
    const asOf = agg.asOf ?? now;

    const prev = st.cumulative;
    const sameDay =
      prev !== null && etDateKey(new Date(asOf)).getTime() === etDateKey(new Date(st.cumulativeAt)).getTime();
    if (prev !== null && sameDay && asOf <= st.cumulativeAt) {
      st.flow = { ...st.flow, lastUpdated: now };
      this.tickers.set(agg.symbol, st);
      return st.flow;
    }
    // A new ET date, or day volumes falling on a NEWER snapshot, means a new session.
    const newSession =
      prev !== null && (!sameDay || agg.putVolume + agg.callVolume < prev.putVolume + prev.callVolume);

    if (newSession) st.intervals = [];
    else if (prev !== null) {
      st.intervals.push({
        start: st.cumulativeAt,
        end: asOf,
        putVolume: Math.max(0, agg.putVolume - prev.putVolume),
        callVolume: Math.max(0, agg.callVolume - prev.callVolume),
        putPremium: Math.max(0, agg.putPremium - prev.putPremium),
        callPremium: Math.max(0, agg.callPremium - prev.callPremium),
      });
      st.intervals = pruneIntervals(st.intervals);
    }
    st.cumulative = { ...agg, contracts: undefined };
    st.cumulativeAt = asOf;

    const w = windowFlow(st.intervals);
    const { putVolume, callVolume, putPremium, callPremium } = w;

    // Window ratio when the window measured flow; otherwise the session ratio.
    const windowHasFlow = w.rawPutVolume + w.rawCallVolume > 0;
    const ratio = windowHasFlow
      ? putCallRatio(w.rawPutVolume, w.rawCallVolume)
      : putCallRatio(agg.putVolume, agg.callVolume);

    // Sparkline: at most one point per minute of data time.
    const lastPoint = st.sparkline[st.sparkline.length - 1];
    if (!lastPoint || asOf - lastPoint.t >= 60_000) {
      st.sparkline.push({ t: asOf, ratio });
      if (st.sparkline.length > SPARKLINE_POINTS) st.sparkline.shift();
    } else {
      lastPoint.ratio = ratio;
    }

    // Expected-volume curves are by time of day: judge the session volume
    // against the moment it reflects, not the (later) moment it arrived.
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
      new Date(asOf),
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

    // IV-direction OI tiebreaker, per side. Needs yesterday's per-side OI/skew.
    const instrument = this.instruments.get(agg.symbol) ?? defaultInstrument(agg.symbol);
    const oiSignals = this.computeOiSignals(analytics, ctx, agg.iv30Change);

    // Event gauge: recompute the live implied move from the chain against the
    // active catalyst, folded into the stored realized distribution.
    const eventInput = this.eventInputs.get(agg.symbol);
    const eventGauge =
      eventInput && agg.contracts && agg.contracts.length > 0
        ? buildEventGauge(eventInput, agg.contracts, agg.underlyingPrice, new Date(now))
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
      // The quote sweep runs on its own (much faster) cadence and rebuilds
      // nothing here, so carry the last live quote across a chain refresh —
      // otherwise the price would blank every time the rotation reaches this
      // name. Reads the previous flow: the literal is evaluated before assign.
      livePrice: st.flow?.livePrice ?? null,
      livePriceChangePct: st.flow?.livePriceChangePct ?? null,
      livePriceAt: st.flow?.livePriceAt ?? null,
      iv30: agg.iv30,
      iv30Change: agg.iv30Change,
      ivRank: ctx?.ivRank ?? analytics?.ivRank ?? null,
      hv20: ctx?.hv20 ?? analytics?.hv20 ?? null,
      oiChangePct,
      analytics,
      inverse: instrument.inverse,
      leverage: instrument.leverage,
      oiSignals,
      sectorRelative: this.sectorRelatives.get(agg.symbol) ?? null,
      conviction: this.convictions.get(agg.symbol) ?? null,
      eventGauge,
      idiosyncraticMoves: this.idiosyncraticMoves.get(agg.symbol) ?? [],
      lastUpdated: now,
      dataAsOf: asOf,
      flowWindowMs: w.coveredMs >= MIN_COVERAGE_MS ? Math.round(w.coveredMs) : null,
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

  /**
   * Overlay live underlying quotes onto whatever the (15-minute delayed) chain
   * rotation last produced. Only the price fields move: every chain-derived
   * analytic — P/C, IV, skew, OI, GEX — keeps the delayed value it was computed
   * from, because mixing a live price into a delayed surface would silently
   * misstate those. `livePriceAt` carries the venue trade time so the UI can age
   * the quote rather than implying it is current.
   *
   * Returns the flows actually touched, so the poller can push just those.
   */
  /**
   * Replace every ticker's learned conviction with a freshly loaded edge book's.
   * Patches existing flows in place (a name the chain rotation has not reached
   * since the book loaded still shows the new value) and clears names whose
   * signals did not fire this session. Returns the flows whose value changed.
   */
  setConvictions(next: ReadonlyMap<string, TickerConviction>): TickerFlow[] {
    this.convictions.clear();
    for (const [symbol, c] of next) this.convictions.set(symbol, c);
    const touched: TickerFlow[] = [];
    for (const [symbol, state] of this.tickers) {
      const c = this.convictions.get(symbol) ?? null;
      if (state.flow.conviction === c) continue;
      state.flow.conviction = c;
      touched.push(state.flow);
    }
    return touched;
  }

  applyQuotes(quotes: { symbol: string; price: number; changePct: number | null; at: number }[]): TickerFlow[] {
    const touched: TickerFlow[] = [];
    for (const q of quotes) {
      const state = this.tickers.get(q.symbol);
      if (!state || !(q.price > 0)) continue;
      state.flow.livePrice = q.price;
      state.flow.livePriceChangePct = q.changePct;
      state.flow.livePriceAt = q.at;
      touched.push(state.flow);
    }
    return touched;
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

  getSectorDispersions(): SectorDispersion[] {
    return [...this.sectorDispersion.values()].sort((a, b) => a.label.localeCompare(b.label));
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
      // Holidays count as closed, matching the poller's idle gate — otherwise
      // the status bar and the health probe disagree on a market holiday.
      marketOpen: isMarketHours() && isTradingDayNow(),
    };
  }

  /** Per-side OI×IV tiebreaker from live analytics vs yesterday's per-side OI/skew. */
  private computeOiSignals(
    analytics: { putOI: number; callOI: number; rrSkew25: number | null } | null,
    ctx: VolContext | undefined,
    iv30Change: number | null,
  ): { call: SideFlow; put: SideFlow; iv30Change: number | null; skewChange: number | null } | null {
    if (!analytics || !ctx || ctx.prevPutOI === null || ctx.prevCallOI === null) return null;
    const callOiPct = ctx.prevCallOI > 0 ? ((analytics.callOI - ctx.prevCallOI) / ctx.prevCallOI) * 100 : null;
    const putOiPct = ctx.prevPutOI > 0 ? ((analytics.putOI - ctx.prevPutOI) / ctx.prevPutOI) * 100 : null;
    const skewChange = analytics.rrSkew25 !== null && ctx.prevRrSkew !== null ? analytics.rrSkew25 - ctx.prevRrSkew : null;
    const iv = sideIvChanges(iv30Change, skewChange);
    return {
      call: { oiChangePct: round2(callOiPct), ivChange: round2(iv.call), signal: classifyOiFlow(callOiPct, iv.call) },
      put: { oiChangePct: round2(putOiPct), ivChange: round2(iv.put), signal: classifyOiFlow(putOiPct, iv.put) },
      iv30Change: round2(iv30Change),
      skewChange: round2(skewChange),
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
      cumulativeAt: 0,
      intervals: [],
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
        livePrice: null,
        livePriceChangePct: null,
        livePriceAt: null,
        iv30: null,
        iv30Change: null,
        ivRank: null,
        hv20: null,
        oiChangePct: null,
        analytics: null,
        inverse: defaultInstrument(symbol).inverse,
        leverage: defaultInstrument(symbol).leverage,
        oiSignals: null,
        sectorRelative: null,
        conviction: null,
        eventGauge: null,
        idiosyncraticMoves: [],
        lastUpdated: 0,
        dataAsOf: 0,
        flowWindowMs: null,
        lastDelta: 'none',
      },
    };
  }
}

function round2(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(2));
}

const globalStore = globalThis as unknown as { __flowEngine?: FlowEngine };

export function getFlowEngine(): FlowEngine {
  if (!globalStore.__flowEngine) globalStore.__flowEngine = new FlowEngine();
  return globalStore.__flowEngine;
}
