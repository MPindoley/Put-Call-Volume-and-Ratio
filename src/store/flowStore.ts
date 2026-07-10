'use client';

/**
 * Zustand store for live market state pushed over the socket (server state
 * mirror) plus pure-UI state: filters, sort, pins, notifications.
 *
 * Rows live in a Record keyed by symbol so a flow-update for N tickers is one
 * merge, and unchanged row objects keep their identity — memoized table rows
 * skip re-rendering, which is what keeps 500 tickers flicker-free.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AggregateRatio,
  ConnectionStatus,
  RatioPoint,
  SectorRatio,
  SpikeAlert,
  TickerFlow,
} from '@/types';

export type SortKey =
  | 'symbol'
  | 'putCallRatio'
  | 'putVolume'
  | 'callVolume'
  | 'netFlow'
  | 'premium'
  | 'spikeScore'
  | 'lastUpdated';

export type FlowFilter = 'all' | 'bullish' | 'bearish' | 'unusual';

interface FlowState {
  rows: Record<string, TickerFlow>;
  aggregate: AggregateRatio | null;
  sectors: SectorRatio[];
  ratioSeries: RatioPoint[];
  alerts: SpikeAlert[];
  status: ConnectionStatus | null;
  socketConnected: boolean;
  /** symbol → epoch ms of last significant change (drives row flash). */
  flashes: Record<string, { at: number; direction: 'bullish' | 'bearish' }>;
  unreadAlerts: number;

  // UI state
  search: string;
  sectorFilter: string;
  flowFilter: FlowFilter;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  pinned: string[];

  applyFlowUpdate: (rows: TickerFlow[]) => void;
  applyRatioUpdate: (agg: AggregateRatio, sectors: SectorRatio[], point: RatioPoint) => void;
  applyStatus: (status: ConnectionStatus) => void;
  setSocketConnected: (connected: boolean) => void;
  pushAlert: (alert: SpikeAlert) => void;
  seedAlerts: (alerts: SpikeAlert[]) => void;
  markAlertsRead: () => void;
  hydrate: (data: {
    rows: TickerFlow[];
    aggregate: AggregateRatio | null;
    sectors: SectorRatio[];
    ratioSeries: RatioPoint[];
    status: ConnectionStatus;
  }) => void;

  setSearch: (s: string) => void;
  setSectorFilter: (s: string) => void;
  setFlowFilter: (f: FlowFilter) => void;
  setSort: (key: SortKey) => void;
  togglePin: (symbol: string) => void;
}

const SIGNIFICANT_NET_FLOW = 500; // contracts over the rolling window

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      rows: {},
      aggregate: null,
      sectors: [],
      ratioSeries: [],
      alerts: [],
      status: null,
      socketConnected: false,
      flashes: {},
      unreadAlerts: 0,

      search: '',
      sectorFilter: 'All',
      flowFilter: 'all',
      sortKey: 'spikeScore',
      sortDir: 'desc',
      pinned: [],

      applyFlowUpdate: (incoming) => {
        const { rows, flashes } = get();
        const nextRows = { ...rows };
        const nextFlashes = { ...flashes };
        const now = Date.now();
        for (const row of incoming) {
          const prev = nextRows[row.symbol];
          if (prev && Math.abs(row.netFlow - prev.netFlow) >= SIGNIFICANT_NET_FLOW) {
            nextFlashes[row.symbol] = {
              at: now,
              direction: row.netFlow >= prev.netFlow ? 'bullish' : 'bearish',
            };
          }
          nextRows[row.symbol] = row;
        }
        set({ rows: nextRows, flashes: nextFlashes });
      },

      applyRatioUpdate: (aggregate, sectors, point) =>
        set((state) => {
          const series = [...state.ratioSeries];
          const last = series[series.length - 1];
          if (!last || point.time > last.time) series.push(point);
          else series[series.length - 1] = point;
          return { aggregate, sectors, ratioSeries: series.slice(-500) };
        }),

      applyStatus: (status) => set({ status }),
      setSocketConnected: (socketConnected) => set({ socketConnected }),

      pushAlert: (alert) =>
        set((state) => ({
          alerts: [alert, ...state.alerts].slice(0, 200),
          unreadAlerts: state.unreadAlerts + 1,
        })),
      seedAlerts: (alerts) => set({ alerts }),
      markAlertsRead: () => set({ unreadAlerts: 0 }),

      hydrate: (data) =>
        set({
          rows: Object.fromEntries(data.rows.map((r) => [r.symbol, r])),
          aggregate: data.aggregate,
          sectors: data.sectors,
          ratioSeries: data.ratioSeries,
          status: data.status,
        }),

      setSearch: (search) => set({ search }),
      setSectorFilter: (sectorFilter) => set({ sectorFilter }),
      setFlowFilter: (flowFilter) => set({ flowFilter }),
      setSort: (key) =>
        set((state) =>
          state.sortKey === key
            ? { sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' }
            : { sortKey: key, sortDir: key === 'symbol' ? 'asc' : 'desc' },
        ),
      togglePin: (symbol) =>
        set((state) => ({
          pinned: state.pinned.includes(symbol)
            ? state.pinned.filter((s) => s !== symbol)
            : [...state.pinned, symbol],
        })),
    }),
    {
      name: 'flow-ui-state',
      // Only UI preferences persist; market data always comes fresh.
      partialize: (state) => ({
        pinned: state.pinned,
        sortKey: state.sortKey,
        sortDir: state.sortDir,
        sectorFilter: state.sectorFilter,
        flowFilter: state.flowFilter,
      }),
    },
  ),
);

/** Filtered + sorted view of the table, pins first. */
export function selectVisibleRows(state: FlowState): TickerFlow[] {
  const { rows, search, sectorFilter, flowFilter, sortKey, sortDir, pinned } = state;
  const term = search.trim().toUpperCase();
  const pinSet = new Set(pinned);

  let list = Object.values(rows);
  if (term) list = list.filter((r) => r.symbol.includes(term));
  if (sectorFilter !== 'All') list = list.filter((r) => r.sector === sectorFilter);
  if (flowFilter === 'bullish') list = list.filter((r) => r.callVolume >= r.putVolume * 2 && r.callVolume > 0);
  if (flowFilter === 'bearish') list = list.filter((r) => r.putVolume >= r.callVolume * 2 && r.putVolume > 0);
  if (flowFilter === 'unusual') list = list.filter((r) => r.spikeScore > 70);

  const dir = sortDir === 'asc' ? 1 : -1;
  const value = (r: TickerFlow): number | string => {
    switch (sortKey) {
      case 'symbol': return r.symbol;
      case 'putCallRatio': return r.putCallRatio;
      case 'putVolume': return r.putVolume;
      case 'callVolume': return r.callVolume;
      case 'netFlow': return r.netFlow;
      case 'premium': return r.putPremium + r.callPremium;
      case 'spikeScore': return r.spikeScore;
      case 'lastUpdated': return r.lastUpdated;
    }
  };
  list.sort((a, b) => {
    const pa = pinSet.has(a.symbol) ? 0 : 1;
    const pb = pinSet.has(b.symbol) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const va = value(a);
    const vb = value(b);
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
    return ((va as number) - (vb as number)) * dir;
  });
  return list;
}
