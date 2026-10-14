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
  RealtimeFeedInfo,
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
import { computeProjection, type Projection } from './projection';
import type { CalibrationView, Coverage, HorizonKey } from './projection-history';
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

/** How long a real-time snapshot keeps the delayed feed's flow figures off a row. */
export const REALTIME_FRESH_MS = 10 * 60_000;

/** One feed's view of a ticker's session: its cumulative totals and the deltas between them. */
interface SourceState {
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
  /** Fetch time of the last snapshot that carried new data (0 = never). */
  receivedAt: number;
}

/**
 * Each feed keeps its own session state, so a delta is only ever taken between
 * two snapshots of the SAME feed: Schwab's and CBOE's counts of the same
 * session differ slightly, and a cross-feed delta would read that difference
 * as trading.
 */
interface TickerState {
  /** The feed of record (CBOE / Massive / simulator): analytics always; flow when no real-time. */
  primary: SourceState;
  /** Real-time overlay (Schwab): flow figures only, while fresh. */
  realtime: SourceState;
  flow: TickerFlow;
}

/** A feed's measured window: rates, ratio and data time. */
interface Measured {
  w: ReturnType<typeof windowFlow>;
  ratio: number;
  asOf: number;
  sparkline: number[];
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
  /**
   * Per-ticker market-implied projection from the latest chain (projection.ts).
   * Served to the ticker page only — never broadcast with the table rows.
   */
  readonly projections = new Map<string, Projection>();
  /** Per-ticker realized-vs-implied calibration by horizon, refreshed nightly (projection-jobs.ts). */
  readonly calibrations = new Map<string, Record<HorizonKey, CalibrationView>>();
  /** Graded-projection coverage across all names and per sector, refreshed nightly. */
  projectionCoverage: { all: Record<HorizonKey, Coverage>; bySector: Map<string, Record<HorizonKey, Coverage>> } | null = null;
  marketContext: MarketContext | null = null;
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  mode: DataSourceMode = 'simulated';
  lastPollAt = 0;
  dbConnected = false;
  /** Set by the poller's real-time loop when a real-time feed is configured. */
  realtimeFeed: RealtimeFeedInfo | null = null;
  /** Names left in an after-hours catch-up pass (poller.ts); 0 when none is running. */
  catchUpRemaining = 0;
  /** 20-day aggregate-ratio history for percentile ranking (loaded from DB). */
  historicalRatios: number[] = [];

  /**
   * Ingest a cumulative snapshot from the feed of record for one ticker.
   * Returns the updated row.
   *
   * `now` is when it was fetched; `agg.asOf` is the market moment it reflects
   * (a delayed feed lags the fetch, and a CDN can hand back a snapshot that is
   * older still). All flow timing uses the data time. A snapshot no newer than
   * the last one carries no new information and is not counted again — it
   * would otherwise log a zero-volume interval (a false lull) and count as a
   * second confirming cycle for a spike that never re-occurred.
   *
   * While the real-time feed covers this name (ingestRealtime), its flow
   * figures stay on the row and spike detection runs on its clock alone; this
   * snapshot still refreshes every analytic and advances its own session
   * state, so handing back to the delayed feed is seamless.
   */
  ingest(agg: OptionsChainAggregate, now = Date.now()): TickerFlow {
    const st = this.tickers.get(agg.symbol) ?? this.initTicker(agg.symbol);
    const asOf = agg.asOf ?? now;

    if (!this.advance(st.primary, agg, asOf, now)) {
      st.flow = { ...st.flow, lastUpdated: now };
      this.tickers.set(agg.symbol, st);
      return st.flow;
    }
    const m = this.measure(st.primary, agg, asOf);
    const flow = this.realtimeLive(st, now) ? null : this.flowFields(agg, m, now, false);

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
    // Market-implied projection, from the same chain and data time.
    if (agg.contracts && agg.contracts.length > 0) {
      const projection = computeProjection(agg.symbol, agg.contracts, agg.underlyingPrice, asOf);
      if (projection) this.projections.set(agg.symbol, projection);
    }

    const eventInput = this.eventInputs.get(agg.symbol);
    const eventGauge =
      eventInput && agg.contracts && agg.contracts.length > 0
        ? buildEventGauge(eventInput, agg.contracts, agg.underlyingPrice, new Date(now))
        : null;

    st.flow = {
      // The previous row supplies what this snapshot does not set: the live
      // quote (the quote sweep runs on its own, faster cadence) and, while the
      // real-time feed covers the name, its flow figures.
      ...st.flow,
      ...(flow?.fields ?? {}),
      symbol: agg.symbol,
      sector: sectorOf(agg.symbol),
      underlyingPrice: agg.underlyingPrice,
      priceChangePct: agg.priceChangePct,
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
    };
    this.tickers.set(agg.symbol, st);
    if (flow?.alert) this.pushAlert(flow.alert);
    return st.flow;
  }

  /**
   * Ingest a real-time snapshot (Schwab) for one ticker: flow figures and
   * spike detection only, once this feed has measured a window of its own.
   * Analytics stay on the feed of record; the underlying price goes to the
   * live-price fields, like the quote sweep's.
   */
  ingestRealtime(agg: OptionsChainAggregate, now = Date.now(), priceAt: number | null = null): TickerFlow {
    const st = this.tickers.get(agg.symbol) ?? this.initTicker(agg.symbol);
    const asOf = agg.asOf ?? now;
    if (!this.advance(st.realtime, agg, asOf, now)) return st.flow;

    const at = priceAt ?? asOf;
    const price =
      agg.underlyingPrice > 0 && at >= (st.flow.livePriceAt ?? 0)
        ? { livePrice: agg.underlyingPrice, livePriceChangePct: agg.priceChangePct, livePriceAt: at }
        : {};
    const live = this.realtimeLive(st, now);
    const flow = live ? this.flowFields(agg, this.measure(st.realtime, agg, asOf), now, true) : null;
    st.flow = { ...st.flow, ...price, ...(flow?.fields ?? {}), ...(live ? { lastUpdated: now } : {}) };
    this.tickers.set(agg.symbol, st);
    if (flow?.alert) this.pushAlert(flow.alert);
    return st.flow;
  }

  /** The real-time feed has fresh data and a measured window for this name. */
  private realtimeLive(st: TickerState, now: number): boolean {
    const r = st.realtime;
    return r.receivedAt > 0 && now - r.receivedAt < REALTIME_FRESH_MS && windowFlow(r.intervals).coveredMs >= MIN_COVERAGE_MS;
  }

  /** Advance one feed's session state; false when the snapshot carries nothing new. */
  private advance(src: SourceState, agg: OptionsChainAggregate, asOf: number, now: number): boolean {
    const prev = src.cumulative;
    const sameDay =
      prev !== null && etDateKey(new Date(asOf)).getTime() === etDateKey(new Date(src.cumulativeAt)).getTime();
    if (prev !== null && sameDay && asOf <= src.cumulativeAt) return false;
    // A new ET date, or day volumes falling on a NEWER snapshot, means a new session.
    const newSession =
      prev !== null && (!sameDay || agg.putVolume + agg.callVolume < prev.putVolume + prev.callVolume);

    if (newSession) src.intervals = [];
    else if (prev !== null) {
      src.intervals.push({
        start: src.cumulativeAt,
        end: asOf,
        putVolume: Math.max(0, agg.putVolume - prev.putVolume),
        callVolume: Math.max(0, agg.callVolume - prev.callVolume),
        putPremium: Math.max(0, agg.putPremium - prev.putPremium),
        callPremium: Math.max(0, agg.callPremium - prev.callPremium),
      });
      src.intervals = pruneIntervals(src.intervals);
    }
    src.cumulative = { ...agg, contracts: undefined };
    src.cumulativeAt = asOf;
    src.receivedAt = now;
    return true;
  }

  /** A feed's current window and ratio; advances its sparkline. */
  private measure(src: SourceState, agg: OptionsChainAggregate, asOf: number): Measured {
    const w = windowFlow(src.intervals);
    // Window ratio when the window measured flow; otherwise the session ratio.
    const ratio =
      w.rawPutVolume + w.rawCallVolume > 0
        ? putCallRatio(w.rawPutVolume, w.rawCallVolume)
        : putCallRatio(agg.putVolume, agg.callVolume);

    // Sparkline: at most one point per minute of data time.
    const lastPoint = src.sparkline[src.sparkline.length - 1];
    if (!lastPoint || asOf - lastPoint.t >= 60_000) {
      src.sparkline.push({ t: asOf, ratio });
      if (src.sparkline.length > SPARKLINE_POINTS) src.sparkline.shift();
    } else {
      lastPoint.ratio = ratio;
    }
    return { w, ratio, asOf, sparkline: src.sparkline.map((p) => Number(p.ratio.toFixed(3))) };
  }

  /**
   * The flow half of a row from one feed's measurement, with spike detection.
   * Only one feed per ticker runs this at a time, so the detector's
   * consecutive-cycle count is never fed by two clocks at once.
   */
  private flowFields(
    agg: OptionsChainAggregate,
    m: Measured,
    now: number,
    realtime: boolean,
  ): { fields: Partial<TickerFlow>; alert: SpikeAlert | null } {
    const { putVolume, callVolume, putPremium, callPremium } = m.w;
    const ratio = m.ratio;
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
      new Date(m.asOf),
    );
    const netFlow = callVolume - putVolume;
    const fields: Partial<TickerFlow> = {
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
      ratioSparkline: m.sparkline,
      dataAsOf: m.asOf,
      flowWindowMs: m.w.coveredMs >= MIN_COVERAGE_MS ? Math.round(m.w.coveredMs) : null,
      realtime,
      lastDelta: netFlow > 0 ? 'bullish' : netFlow < 0 ? 'bearish' : 'none',
    };
    // Fire once when a spike is first confirmed, not on every cycle after.
    const alert: SpikeAlert | null =
      spike.alertable && spike.consecutiveCycles === 2
        ? {
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
          }
        : null;
    return { fields, alert };
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
      realtime: this.realtimeInfo(),
      dataAsOf: this.latestDataAsOf(),
      catchUpRemaining: this.catchUpRemaining,
    };
  }

  /** Newest market time any row reflects (0 when there are none). */
  latestDataAsOf(): number {
    let latest = 0;
    for (const st of this.tickers.values()) if (st.flow.dataAsOf > latest) latest = st.flow.dataAsOf;
    return latest;
  }

  /**
   * Seed the engine from a saved snapshot (engine-snapshot.ts) after a restart,
   * so the full table is served at once instead of rebuilding from empty.
   * Rows keep their own data times, so their age shows honestly. A name that
   * already has live data is left alone, and no feed state is restored: the
   * next live snapshot starts a fresh measurement window, so a delta is never
   * taken against a snapshot this process did not see.
   */
  restoreSnapshot(s: {
    flows: TickerFlow[];
    projections: Projection[];
    aggregate: AggregateRatio | null;
    sectors: SectorRatio[];
    ratioSeries: RatioPoint[];
    marketContext: MarketContext | null;
  }): number {
    let restored = 0;
    for (const flow of s.flows) {
      if (this.tickers.has(flow.symbol)) continue;
      const st = this.initTicker(flow.symbol);
      // The real-time overlay is not live in this process (yet).
      st.flow = { ...st.flow, ...flow, realtime: false };
      this.tickers.set(flow.symbol, st);
      restored += 1;
    }
    for (const p of s.projections) if (!this.projections.has(p.symbol)) this.projections.set(p.symbol, p);
    this.lastAggregate ??= s.aggregate;
    if (this.sectors.length === 0) this.sectors = s.sectors;
    if (this.ratioSeries.length === 0) this.ratioSeries = s.ratioSeries;
    this.marketContext ??= s.marketContext;
    return restored;
  }

  /** The real-time feed's state as the poller last reported it, with the live count now. */
  realtimeInfo(now = Date.now()): RealtimeFeedInfo | null {
    if (!this.realtimeFeed) return null;
    let live = 0;
    for (const st of this.tickers.values()) if (this.realtimeLive(st, now)) live += 1;
    return { ...this.realtimeFeed, liveTickers: live };
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
    const source = (): SourceState => ({ cumulative: null, cumulativeAt: 0, intervals: [], sparkline: [], receivedAt: 0 });
    return {
      primary: source(),
      realtime: source(),
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
        realtime: false,
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
