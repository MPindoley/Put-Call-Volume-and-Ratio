'use client';

/**
 * Live options flow table. Virtualized (@tanstack/react-virtual) so 500 rows
 * render smoothly; each row is memoized and only re-renders when its own
 * TickerFlow object identity changes. Sortable columns, sector/flow filters,
 * ticker search, pin-to-top, and flash-on-significant-flow.
 */
import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SpikeBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCompact, formatPremium, formatRatio, formatTime } from '@/lib/utils';
import { SECTORS } from '@/lib/universe';
import { selectVisibleRows, useFlowStore, type FlowFilter, type SortKey } from '@/store/flowStore';
import type { TickerFlow } from '@/types';
import { Sparkline } from './Sparkline';

const COLUMNS: { key: SortKey | null; label: string; className: string }[] = [
  { key: 'symbol', label: 'Ticker', className: 'w-24' },
  { key: 'putCallRatio', label: 'P/C', className: 'w-16 text-right' },
  { key: 'putVolume', label: 'Puts 5m', className: 'w-20 text-right' },
  { key: 'callVolume', label: 'Calls 5m', className: 'w-20 text-right' },
  { key: 'netFlow', label: 'Net Flow', className: 'w-20 text-right' },
  { key: 'premium', label: 'Premium 5m', className: 'w-24 text-right' },
  { key: 'spikeScore', label: 'Unusual', className: 'w-28' },
  { key: null, label: 'P/C 30m', className: 'w-28' },
  { key: 'lastUpdated', label: 'Updated', className: 'w-20 text-right' },
];

const ROW_HEIGHT = 40;

function Row({ row, pinned, flash }: { row: TickerFlow; pinned: boolean; flash: 'bullish' | 'bearish' | null }): JSX.Element {
  const togglePin = useFlowStore((s) => s.togglePin);
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-surface-border/50 px-3 text-xs hover:bg-surface-overlay/50',
        flash === 'bullish' && 'animate-flash-green',
        flash === 'bearish' && 'animate-flash-red',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <div className="flex w-24 items-center gap-1.5">
        <button
          onClick={() => togglePin(row.symbol)}
          className={cn('text-[10px]', pinned ? 'text-caution' : 'text-slate-600 hover:text-slate-400')}
          title={pinned ? 'Unpin' : 'Pin to top'}
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${row.symbol}`}
        >
          {pinned ? '★' : '☆'}
        </button>
        <a href={`/ticker/${row.symbol}`} className="font-semibold text-slate-100 hover:text-blue-400">
          {row.symbol}
        </a>
      </div>
      <span className={cn('w-16 text-right tnum font-semibold', row.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')}>
        {formatRatio(row.putCallRatio)}
      </span>
      <span className="w-20 text-right tnum text-slate-300">{formatCompact(row.putVolume)}</span>
      <span className="w-20 text-right tnum text-slate-300">{formatCompact(row.callVolume)}</span>
      <span className={cn('w-20 text-right tnum', row.netFlow > 0 ? 'text-bullish' : row.netFlow < 0 ? 'text-bearish' : 'text-slate-500')}>
        {row.netFlow > 0 ? '+' : ''}
        {formatCompact(row.netFlow)}
      </span>
      <span className="w-24 text-right tnum text-slate-300" title={`Calls ${formatPremium(row.callPremium)} · Puts ${formatPremium(row.putPremium)}`}>
        {formatPremium(row.callPremium + row.putPremium)}
      </span>
      <span className="flex w-28 items-center gap-1.5">
        <SpikeBadge level={row.spikeLevel} />
        <span className="tnum text-slate-400" title={`Unusual activity score ${row.spikeScore}/100 · volume ${row.volumeVsExpected.toFixed(1)}× expected`}>
          {row.spikeScore}
        </span>
      </span>
      <span className="w-28">
        <Sparkline points={row.ratioSparkline} />
      </span>
      <span className="w-20 text-right tnum text-slate-500">
        {row.lastUpdated > 0 ? formatTime(row.lastUpdated) : '—'}
      </span>
    </div>
  );
}

const MemoRow = memo(Row);

const FLOW_FILTERS: { value: FlowFilter; label: string }[] = [
  { value: 'all', label: 'All flow' },
  { value: 'bullish', label: 'Bullish 2×' },
  { value: 'bearish', label: 'Bearish 2×' },
  { value: 'unusual', label: 'Unusual >70' },
];

export function FlowTable({ isLoading }: { isLoading: boolean }): JSX.Element {
  const rows = useFlowStore(selectVisibleRows);
  const search = useFlowStore((s) => s.search);
  const setSearch = useFlowStore((s) => s.setSearch);
  const sectorFilter = useFlowStore((s) => s.sectorFilter);
  const setSectorFilter = useFlowStore((s) => s.setSectorFilter);
  const flowFilter = useFlowStore((s) => s.flowFilter);
  const setFlowFilter = useFlowStore((s) => s.setFlowFilter);
  const sortKey = useFlowStore((s) => s.sortKey);
  const sortDir = useFlowStore((s) => s.sortDir);
  const setSort = useFlowStore((s) => s.setSort);
  const pinned = useFlowStore((s) => s.pinned);
  const flashes = useFlowStore((s) => s.flashes);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const now = Date.now();
  const pinSet = new Set(pinned);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-surface-border bg-surface-raised">
      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker…"
          className="w-36 rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          aria-label="Search ticker"
        />
        <select
          value={sectorFilter}
          onChange={(e) => setSectorFilter(e.target.value)}
          className="rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 focus:outline-none"
          aria-label="Filter by sector"
        >
          <option value="All">All sectors</option>
          {SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded border border-surface-border" role="group" aria-label="Flow direction filter">
          {FLOW_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFlowFilter(f.value)}
              className={cn(
                'px-2 py-1 text-[11px]',
                flowFilter === f.value ? 'bg-surface-overlay text-slate-100' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-slate-500 tnum">{rows.length} tickers</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-2 border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {COLUMNS.map((col) => (
          <button
            key={col.label}
            disabled={col.key === null}
            onClick={() => col.key && setSort(col.key)}
            className={cn('text-left', col.className, col.key && 'hover:text-slate-300')}
          >
            {col.label}
            {col.key === sortKey && <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ))}
      </div>

      {/* Virtualized body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading && rows.length === 0 ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-500">
            {search || sectorFilter !== 'All' || flowFilter !== 'all'
              ? 'No tickers match the current filters.'
              : 'No flow data yet — waiting for the first poll cycle.'}
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              const flashInfo = flashes[row.symbol];
              const flash = flashInfo && now - flashInfo.at < 1_500 ? flashInfo.direction : null;
              return (
                <div
                  key={row.symbol}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  <MemoRow row={row} pinned={pinSet.has(row.symbol)} flash={flash} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
