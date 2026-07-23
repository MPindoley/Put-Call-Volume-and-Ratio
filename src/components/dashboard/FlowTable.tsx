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

const COLUMNS: { key: SortKey | null; label: string; className: string; title?: string }[] = [
  { key: 'symbol', label: 'Ticker', className: 'w-24' },
  { key: 'putCallRatio', label: 'P/C', className: 'w-14 text-right' },
  { key: 'putVolume', label: 'Puts 5m', className: 'w-16 text-right' },
  { key: 'callVolume', label: 'Calls 5m', className: 'w-16 text-right' },
  { key: 'netFlow', label: 'Net Flow', className: 'w-16 text-right' },
  { key: 'premium', label: 'Prem 5m', className: 'w-20 text-right' },
  { key: 'iv30', label: 'IV30', className: 'w-16 text-right', title: '30-day implied volatility (with day change)' },
  { key: 'ivRank', label: 'IVR', className: 'w-11 text-right', title: 'IV rank: percentile of IV30 vs stored history' },
  { key: 'rrSkew', label: 'Skew', className: 'w-14 text-right', title: '25Δ risk reversal (call IV − put IV, vol pts). Negative = normal put skew; positive = calls bid over puts' },
  { key: 'oiPutCall', label: 'OI P/C', className: 'w-14 text-right', title: 'Open-interest put/call ratio (positioning, not volume)' },
  { key: 'skewZ30', label: 'zSkew30', className: 'w-16 text-right', title: 'Sector-relative skew z-score, 30-day window (ticker skew minus sector median, vs its own history)' },
  { key: 'skewZ90', label: 'zSkew90', className: 'w-16 text-right', title: 'Sector-relative skew z-score, 90-day window' },
  { key: 'spikeScore', label: 'Unusual', className: 'w-28' },
  { key: null, label: 'P/C 30m', className: 'w-28' },
  { key: 'lastUpdated', label: 'Updated', className: 'w-16 text-right' },
];

/**
 * z-score cell rendered as BACKGROUND INTENSITY, not a printed number
 * (UI-CONSTRAINTS §3): hue by sign (green bullish z<0 / red bearish z>0, one
 * colour meaning), opacity ∝ |z| saturating near |z|=3; the value shows on hover.
 * A muted `—` while the window is still filling (§4).
 */
function ZCell({ z, window }: { z: number | null; window: number }): JSX.Element {
  if (z === null) {
    return (
      <span className="w-16 text-right tnum text-slate-600" title={`Accumulating — need ~${window} finalized days`}>
        —
      </span>
    );
  }
  const mag = Math.abs(z);
  const intensity = Math.min(mag / 3, 1); // saturate near |z| = 3
  // Bearish (skew rising vs peers) = red; bullish = green. Sub-1σ stays neutral.
  const rgb = mag < 1 ? '148,163,184' : z > 0 ? '248,113,113' : '74,222,128';
  return (
    <span
      className="flex w-16 items-center justify-end"
      title={`z ${z >= 0 ? '+' : ''}${z.toFixed(2)} (${window}-day) — ${
        mag < 1 ? 'within 1σ of sector history' : `${mag.toFixed(1)}σ ${z > 0 ? 'above (bearish)' : 'below (bullish)'}`
      }`}
    >
      <span
        aria-hidden
        className="h-4 rounded-sm"
        style={{
          width: `${Math.round(20 + intensity * 24)}px`,
          backgroundColor: `rgba(${rgb},${(0.12 + intensity * 0.68).toFixed(2)})`,
        }}
      />
      <span className="sr-only">
        {z >= 0 ? '+' : ''}
        {z.toFixed(1)}
      </span>
    </span>
  );
}

const ROW_HEIGHT = 40;

/** Skew cell color, inverse-aware: an inverse product's call-skew bid reads bearish for underlying exposure. */
function skewColor(rrSkew25: number | null, inverse: boolean): string {
  if (rrSkew25 == null) return 'text-slate-600';
  const bullish = inverse ? rrSkew25 < 0 : rrSkew25 > 0;
  const bearish = inverse ? rrSkew25 > 4 : rrSkew25 < -4;
  return bullish ? 'text-bullish' : bearish ? 'text-bearish' : 'text-slate-400';
}

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
        {row.sectorRelative?.regimeDetach && (
          <span
            className="text-[9px] text-caution"
            title={`Regime shift: ${row.sectorRelative.regimeDetachMetric} relative spread ${row.sectorRelative.regimeDetachDir} vs sector`}
          >
            ◆
          </span>
        )}
        {row.sectorRelative?.divergence === 'distribution' && (
          <span className="text-[10px] text-bearish" title="Distribution: price up while skew-z deteriorating (heuristic screen, not a significance test — see ticker page for HAC t)">
            ▽
          </span>
        )}
        {row.sectorRelative?.divergence === 'accumulation' && (
          <span className="text-[10px] text-bullish" title="Accumulation: price down/flat while skew-z improving (heuristic screen, not a significance test — see ticker page for HAC t)">
            △
          </span>
        )}
        {row.inverse && (
          <span className="text-[8px] font-semibold text-caution" title={`Inverse${row.leverage !== 1 ? ` ${row.leverage}×` : ''} — skew read in underlying-exposure terms`}>
            INV
          </span>
        )}
      </div>
      <span className={cn('w-14 text-right tnum font-semibold', row.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')}>
        {formatRatio(row.putCallRatio)}
      </span>
      <span className="w-16 text-right tnum text-slate-300">{formatCompact(row.putVolume)}</span>
      <span className="w-16 text-right tnum text-slate-300">{formatCompact(row.callVolume)}</span>
      <span className={cn('w-16 text-right tnum', row.netFlow > 0 ? 'text-bullish' : row.netFlow < 0 ? 'text-bearish' : 'text-slate-500')}>
        {row.netFlow > 0 ? '+' : ''}
        {formatCompact(row.netFlow)}
      </span>
      <span className="w-20 text-right tnum text-slate-300" title={`Calls ${formatPremium(row.callPremium)} · Puts ${formatPremium(row.putPremium)}`}>
        {formatPremium(row.callPremium + row.putPremium)}
      </span>
      <span
        className="w-16 text-right tnum text-slate-300"
        title={row.iv30Change !== null ? `IV30 day change ${row.iv30Change >= 0 ? '+' : ''}${row.iv30Change.toFixed(1)}` : undefined}
      >
        {row.iv30 !== null ? row.iv30.toFixed(1) : '—'}
        {row.iv30Change !== null && row.iv30Change !== 0 && (
          <span className={row.iv30Change > 0 ? 'text-bearish' : 'text-bullish'}>{row.iv30Change > 0 ? '↑' : '↓'}</span>
        )}
      </span>
      <span className={cn('w-11 text-right tnum', (row.ivRank ?? 0) >= 75 ? 'text-caution' : 'text-slate-400')}>
        {row.ivRank !== null ? row.ivRank : '—'}
      </span>
      <span
        className={cn('w-14 text-right tnum', skewColor(row.analytics?.rrSkew25 ?? null, row.inverse))}
        title={row.inverse ? 'Inverse product: skew colored in underlying-exposure terms (raw value shown)' : undefined}
      >
        {row.analytics?.rrSkew25 != null
          ? `${row.analytics.rrSkew25 > 0 ? '+' : ''}${row.analytics.rrSkew25.toFixed(1)}`
          : '—'}
      </span>
      <span className={cn('w-14 text-right tnum', (row.analytics?.oiPutCall ?? 1) > 1 ? 'text-bearish' : 'text-bullish')}>
        {row.analytics?.oiPutCall != null ? row.analytics.oiPutCall.toFixed(2) : '—'}
      </span>
      <ZCell z={row.sectorRelative?.skewZ30 ?? null} window={30} />
      <ZCell z={row.sectorRelative?.skewZ90 ?? null} window={90} />
      <span className="flex w-28 items-center gap-1.5">
        <SpikeBadge level={row.spikeLevel} />
        <span className="tnum text-slate-400" title={`Unusual activity score ${row.spikeScore}/100 · volume ${row.volumeVsExpected.toFixed(1)}× expected`}>
          {row.spikeScore}
        </span>
      </span>
      <span className="w-28">
        <Sparkline points={row.ratioSparkline} />
      </span>
      <span className="w-16 text-right tnum text-slate-500">
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
          id="ticker-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker… ( / )"
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

      {/* Header + body share one horizontal scroll context */}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex min-w-[1360px] items-center gap-2 border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {COLUMNS.map((col) => (
            <button
              key={col.label}
              disabled={col.key === null}
              onClick={() => col.key && setSort(col.key)}
              title={col.title}
              className={cn('text-left', col.className, col.key && 'hover:text-slate-300')}
            >
              {col.label}
              {col.key === sortKey && <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button>
          ))}
        </div>

        {/* Virtualized body */}
        <div ref={scrollRef} className="h-[calc(100%-29px)] min-w-[1360px] overflow-y-auto">
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
    </div>
  );
}
