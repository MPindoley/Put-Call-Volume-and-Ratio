'use client';

/**
 * Live options flow table. Virtualized (@tanstack/react-virtual) so 500 rows
 * render smoothly; each row is memoized and only re-renders when its own
 * TickerFlow object identity changes. Sortable columns, sector/flow filters,
 * the global ticker search (top bar), pin-to-top, and flash-on-significant-flow.
 *
 * Columns fit the space: when the table is narrower than all 17 columns it
 * drops the least important ones in a fixed order (src/lib/table-columns.ts)
 * instead of scrolling sideways, and the Columns menu lets you hide any of
 * them yourself (remembered per browser).
 */
import Link from 'next/link';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SpikeBadge } from '@/components/ui/badge';
import { ConvictionCell, QUOTE_STALE_MS } from '@/components/ui/conviction';
import { Skeleton } from '@/components/ui/skeleton';
import { usePersistentState } from '@/hooks/usePersistentState';
import { COLUMN_DEFS, fitColumns, rowWidth, type ColumnId } from '@/lib/table-columns';
import { cn, formatCompact, formatPremium, formatRatio, formatTime } from '@/lib/utils';
import { SECTORS } from '@/lib/universe';
import { selectVisibleRows, useFlowStore, type FlowFilter, type SortKey } from '@/store/flowStore';
import type { TickerFlow } from '@/types';
import { Sparkline } from './Sparkline';

/** Per-column header behaviour. Width and drop order live in COLUMN_DEFS. */
const COLUMN_META: Record<ColumnId, { sort: SortKey | null; align: 'left' | 'right'; title?: string }> = {
  symbol: { sort: 'symbol', align: 'left' },
  livePrice: {
    sort: 'livePrice',
    align: 'right',
    title: 'Live last-trade price and % change. Independent of the 15-minute delayed option chain — dimmed when the quote is stale, "—" when there is none',
  },
  conviction: {
    sort: 'conviction',
    align: 'right',
    title:
      "Learned conviction: this name's signals from the latest session, each weighted by how well that signal has ACTUALLY worked — hit-rate points above the no-skill base rate, shrunk toward zero on thin evidence. \"—\" = no signal, or not enough evidence to say",
  },
  putCallRatio: {
    sort: 'putCallRatio',
    align: 'right',
    title: 'Put/call volume ratio over the latest ~5 minutes of data (the session ratio until two snapshots exist)',
  },
  putVolume: { sort: 'putVolume', align: 'right', title: 'Put contracts per 5 minutes, measured over the latest data. A rate, so names refreshed at different speeds compare; hover a cell for the minutes it was measured over' },
  callVolume: { sort: 'callVolume', align: 'right', title: 'Call contracts per 5 minutes, measured over the latest data. A rate, so names refreshed at different speeds compare; hover a cell for the minutes it was measured over' },
  netFlow: { sort: 'netFlow', align: 'right', title: 'Calls minus puts, per 5 minutes (measured over the latest data)' },
  premium: { sort: 'premium', align: 'right', title: 'Option premium traded per 5 minutes (measured over the latest data)' },
  iv30: { sort: 'iv30', align: 'right', title: '30-day implied volatility (with day change)' },
  ivRank: { sort: 'ivRank', align: 'right', title: 'IV rank: percentile of IV30 vs stored history' },
  rrSkew: {
    sort: 'rrSkew',
    align: 'right',
    title: '25Δ risk reversal (call IV − put IV, vol pts). Negative = normal put skew; positive = calls bid over puts',
  },
  oiPutCall: { sort: 'oiPutCall', align: 'right', title: 'Open-interest put/call ratio (positioning, not volume)' },
  skewZ30: {
    sort: 'skewZ30',
    align: 'right',
    title: 'Sector-relative skew z-score, 30-day window (ticker skew minus sector median, vs its own history)',
  },
  skewZ90: { sort: 'skewZ90', align: 'right', title: 'Sector-relative skew z-score, 90-day window' },
  spikeScore: { sort: 'spikeScore', align: 'left', title: 'Unusual-activity level and score (0–100)' },
  sparkline: { sort: null, align: 'left', title: 'Put/call ratio over the last 30 minutes' },
  lastUpdated: {
    sort: 'lastUpdated',
    align: 'right',
    title: 'Market time the option data reflects (ET). The free feed runs 15 minutes behind; dimmed when a row is much older than that',
  },
};

const DEF_BY_ID = new Map(COLUMN_DEFS.map((c) => [c.id, c]));

/**
 * z-score cell rendered as BACKGROUND INTENSITY, not a printed number
 * (UI-CONSTRAINTS §3): hue by sign (green bullish z<0 / red bearish z>0, one
 * colour meaning), opacity ∝ |z| saturating near |z|=3; the value shows on hover.
 * A muted `—` while the window is still filling (§4).
 */
function ZCell({ z, window }: { z: number | null; window: number }): JSX.Element {
  if (z === null) {
    return (
      <span className="tnum text-slate-600" title={`Accumulating — need ~${window} finalized days`}>
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
      className="flex items-center"
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

const ROW_HEIGHT = 32;

/** Skew cell color, inverse-aware: an inverse product's call-skew bid reads bearish for underlying exposure. */
function skewColor(rrSkew25: number | null, inverse: boolean): string {
  if (rrSkew25 == null) return 'text-slate-600';
  const bullish = inverse ? rrSkew25 < 0 : rrSkew25 > 0;
  const bearish = inverse ? rrSkew25 > 4 : rrSkew25 < -4;
  return bullish ? 'text-bullish' : bearish ? 'text-bearish' : 'text-slate-400';
}


/**
 * Live last-trade price. This is the one column NOT derived from the delayed
 * option chain, so it must never silently borrow the chain's price: with no
 * live quote it shows "—" (UI-CONSTRAINTS §4, absence styled as absence), and a
 * quote past QUOTE_STALE_MS dims rather than pretending to be current. The
 * delayed chain price stays available on hover for comparison.
 */
function PriceCell({ row }: { row: TickerFlow }): JSX.Element {
  const { livePrice, livePriceChangePct, livePriceAt } = row;
  if (livePrice === null) {
    return (
      <span className="tnum text-slate-600" title="No live quote yet">
        —
      </span>
    );
  }
  const ageMs = livePriceAt !== null ? Date.now() - livePriceAt : null;
  const stale = ageMs !== null && ageMs > QUOTE_STALE_MS;
  const dir = livePriceChangePct === null ? 0 : Math.sign(livePriceChangePct);
  const delayed = row.underlyingPrice > 0 ? `delayed chain px ${row.underlyingPrice.toFixed(2)}` : 'no chain price yet';
  return (
    <span
      className={cn(
        'whitespace-nowrap tnum',
        stale ? 'text-slate-500' : dir > 0 ? 'text-bullish' : dir < 0 ? 'text-bearish' : 'text-slate-300',
      )}
      title={
        `Live ${livePrice.toFixed(2)}` +
        (livePriceChangePct !== null ? ` (${livePriceChangePct >= 0 ? '+' : ''}${livePriceChangePct.toFixed(2)}%)` : '') +
        (ageMs !== null ? ` · ${Math.round(ageMs / 1000)}s old${stale ? ' (stale)' : ''}` : '') +
        ` · ${delayed}`
      }
    >
      {livePrice.toFixed(2)}
      {livePriceChangePct !== null && (
        <span className="ml-1 text-[10px]">
          {livePriceChangePct >= 0 ? '+' : ''}
          {livePriceChangePct.toFixed(1)}%
        </span>
      )}
    </span>
  );
}

function TickerCell({ row, pinned }: { row: TickerFlow; pinned: boolean }): JSX.Element {
  const togglePin = useFlowStore((s) => s.togglePin);
  return (
    <span className="flex items-center gap-1.5">
      <button
        onClick={() => togglePin(row.symbol)}
        className={cn('text-[10px]', pinned ? 'text-caution' : 'text-slate-600 hover:text-slate-400')}
        title={pinned ? 'Unpin' : 'Pin to top'}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${row.symbol}`}
      >
        {pinned ? '★' : '☆'}
      </button>
      <Link href={`/ticker/${row.symbol}`} prefetch={false} className="font-semibold text-slate-100 hover:text-blue-400">
        {row.symbol}
      </Link>
      {row.realtime && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-bullish"
          aria-label="real-time"
          title="Flow is real time (Schwab); IV and OI analytics come from the delayed feed"
        />
      )}
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
    </span>
  );
}

/** A row whose data is this far behind the clock is older than the feed's normal lag and is dimmed. */
const DATA_STALE_MS = 35 * 60_000;

function windowTitle(row: TickerFlow): string {
  if (row.flowWindowMs === null) return 'Not enough data yet for a 5-minute rate (needs two snapshots at least a minute apart)';
  const mins = row.flowWindowMs / 60_000;
  return `Rate per 5 minutes, measured over ${mins.toFixed(mins < 10 ? 1 : 0)} min of data ending ${formatTime(row.dataAsOf)} ET`;
}

/** Market time of the row's option data, aged against the clock (UI-CONSTRAINTS §4: old data dims, never alarms). */
function AsOfCell({ row }: { row: TickerFlow }): JSX.Element {
  if (row.dataAsOf <= 0) return <span className="tnum text-slate-600">—</span>;
  const ageMin = Math.max(0, Math.round((Date.now() - row.dataAsOf) / 60_000));
  const stale = Date.now() - row.dataAsOf > DATA_STALE_MS;
  return (
    <span
      className={cn('tnum', stale ? 'text-slate-600' : 'text-slate-500')}
      title={
        `Option data as of ${formatTime(row.dataAsOf)} ET (${ageMin} min ago) · fetched ${formatTime(row.lastUpdated)} ET` +
        (row.realtime ? ' · flow real-time from Schwab; IV/OI analytics from the delayed feed' : '')
      }
    >
      {formatTime(row.dataAsOf)}
    </span>
  );
}

/** The 5-minute columns before a rate exists: absence, styled as absence (§4) — never a misleading 0. */
function NotMeasured({ row }: { row: TickerFlow }): JSX.Element {
  return (
    <span className="tnum text-slate-600" title={windowTitle(row)}>
      —
    </span>
  );
}

const WINDOW_COLUMNS = new Set<ColumnId>(['putVolume', 'callVolume', 'netFlow', 'premium']);

function CellContent({ id, row, pinned }: { id: ColumnId; row: TickerFlow; pinned: boolean }): JSX.Element {
  if (WINDOW_COLUMNS.has(id) && row.flowWindowMs === null) return <NotMeasured row={row} />;
  switch (id) {
    case 'symbol':
      return <TickerCell row={row} pinned={pinned} />;
    case 'livePrice':
      return <PriceCell row={row} />;
    case 'conviction':
      return <ConvictionCell row={row} />;
    case 'putCallRatio':
      return (
        <span className={cn('tnum font-semibold', row.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')}>
          {formatRatio(row.putCallRatio)}
        </span>
      );
    case 'putVolume':
      return (
        <span className="tnum text-slate-300" title={windowTitle(row)}>
          {formatCompact(row.putVolume)}
        </span>
      );
    case 'callVolume':
      return (
        <span className="tnum text-slate-300" title={windowTitle(row)}>
          {formatCompact(row.callVolume)}
        </span>
      );
    case 'netFlow':
      return (
        <span className={cn('tnum', row.netFlow > 0 ? 'text-bullish' : row.netFlow < 0 ? 'text-bearish' : 'text-slate-500')}>
          {row.netFlow > 0 ? '+' : ''}
          {formatCompact(row.netFlow)}
        </span>
      );
    case 'premium':
      return (
        <span className="tnum text-slate-300" title={`Calls ${formatPremium(row.callPremium)} · Puts ${formatPremium(row.putPremium)}`}>
          {formatPremium(row.callPremium + row.putPremium)}
        </span>
      );
    case 'iv30':
      return (
        <span
          className="tnum text-slate-300"
          title={row.iv30Change !== null ? `IV30 day change ${row.iv30Change >= 0 ? '+' : ''}${row.iv30Change.toFixed(1)}` : undefined}
        >
          {row.iv30 !== null ? row.iv30.toFixed(1) : '—'}
          {row.iv30Change !== null && row.iv30Change !== 0 && (
            <span className={row.iv30Change > 0 ? 'text-bearish' : 'text-bullish'}>{row.iv30Change > 0 ? '↑' : '↓'}</span>
          )}
        </span>
      );
    case 'ivRank':
      return (
        <span className={cn('tnum', (row.ivRank ?? 0) >= 75 ? 'text-caution' : 'text-slate-400')}>
          {row.ivRank !== null ? row.ivRank : '—'}
        </span>
      );
    case 'rrSkew':
      return (
        <span
          className={cn('tnum', skewColor(row.analytics?.rrSkew25 ?? null, row.inverse))}
          title={row.inverse ? 'Inverse product: skew colored in underlying-exposure terms (raw value shown)' : undefined}
        >
          {row.analytics?.rrSkew25 != null
            ? `${row.analytics.rrSkew25 > 0 ? '+' : ''}${row.analytics.rrSkew25.toFixed(1)}`
            : '—'}
        </span>
      );
    case 'oiPutCall':
      return (
        <span className={cn('tnum', (row.analytics?.oiPutCall ?? 1) > 1 ? 'text-bearish' : 'text-bullish')}>
          {row.analytics?.oiPutCall != null ? row.analytics.oiPutCall.toFixed(2) : '—'}
        </span>
      );
    case 'skewZ30':
      return <ZCell z={row.sectorRelative?.skewZ30 ?? null} window={30} />;
    case 'skewZ90':
      return <ZCell z={row.sectorRelative?.skewZ90 ?? null} window={90} />;
    case 'spikeScore':
      return (
        <span className="flex items-center gap-1.5">
          <SpikeBadge level={row.spikeLevel} />
          <span className="tnum text-slate-400" title={`Unusual activity score ${row.spikeScore}/100 · volume ${row.volumeVsExpected.toFixed(1)}× expected`}>
            {row.spikeScore}
          </span>
        </span>
      );
    case 'sparkline':
      return <Sparkline points={row.ratioSparkline} />;
    case 'lastUpdated':
      return <AsOfCell row={row} />;
  }
}

function Row({
  row,
  pinned,
  flash,
  columns,
}: {
  row: TickerFlow;
  pinned: boolean;
  flash: 'bullish' | 'bearish' | null;
  columns: readonly ColumnId[];
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-surface-border/50 px-3 text-xs hover:bg-surface-overlay/50',
        flash === 'bullish' && 'animate-flash-green',
        flash === 'bearish' && 'animate-flash-red',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {columns.map((id) => (
        <div
          key={id}
          className={cn('flex shrink-0 items-center', COLUMN_META[id].align === 'right' ? 'justify-end' : 'justify-start')}
          style={{ width: DEF_BY_ID.get(id)?.width }}
        >
          <CellContent id={id} row={row} pinned={pinned} />
        </div>
      ))}
    </div>
  );
}

const MemoRow = memo(Row);

const FLOW_FILTERS: { value: FlowFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'All tickers' },
  { value: 'bullish', label: 'Calls 2×', title: 'Call volume at least twice put volume (5m)' },
  { value: 'bearish', label: 'Puts 2×', title: 'Put volume at least twice call volume (5m)' },
  { value: 'unusual', label: 'Unusual', title: 'Unusual-activity score above 70' },
];

const isColumnIdArray = (v: unknown): v is ColumnId[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && DEF_BY_ID.has(x as ColumnId));

/** Vertical scrollbar allowance (globals.css sets 10px) so the last column never hides under it. */
const SCROLLBAR_PX = 12;

function ColumnsMenu({
  hidden,
  droppedForSpace,
  onToggle,
  onReset,
}: {
  hidden: readonly ColumnId[];
  droppedForSpace: readonly ColumnId[];
  onToggle: (id: ColumnId) => void;
  onReset: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hiddenCount = hidden.length + droppedForSpace.length;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded border border-surface-border px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
        title="Choose which columns to show"
      >
        Columns
        {hiddenCount > 0 && <span className="tnum text-slate-500">({COLUMN_DEFS.length - hiddenCount}/{COLUMN_DEFS.length})</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-60 rounded-md border border-surface-border bg-surface-raised p-2 shadow-2xl">
          <ul className="max-h-80 space-y-0.5 overflow-auto">
            {COLUMN_DEFS.filter((c) => c.hideable).map((c) => {
              const userHidden = hidden.includes(c.id);
              const noRoom = droppedForSpace.includes(c.id);
              return (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-surface-overlay">
                    <input type="checkbox" checked={!userHidden} onChange={() => onToggle(c.id)} className="h-3.5 w-3.5 accent-blue-500" />
                    <span className="flex-1">{c.label}</span>
                    {noRoom && (
                      <span className="text-[10px] text-slate-500" title="Hidden automatically: not enough width. Widen the window, collapse the side panel, or hide another column.">
                        no room
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex items-center justify-between border-t border-surface-border px-1.5 pt-1.5 text-[10px] text-slate-500">
            <span>Narrow screens drop the least important first.</span>
            <button onClick={onReset} className="text-blue-400 hover:text-blue-300">
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowTable({
  isLoading,
  panelOpen,
  onTogglePanel,
}: {
  isLoading: boolean;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}): JSX.Element {
  const rows = useFlowStore(selectVisibleRows);
  const totalRows = useFlowStore((s) => Object.keys(s.rows).length);
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

  const [hidden, setHidden] = usePersistentState<ColumnId[]>('flow-table-hidden-columns', [], isColumnIdArray);
  const [width, setWidth] = useState<number>(Number.POSITIVE_INFINITY);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.floor(w) - SCROLLBAR_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useMemo(() => fitColumns(width, new Set(hidden)), [width, hidden]);
  const visibleKey = fit.visible.join(',');
  const columns = useMemo(() => visibleKey.split(',') as ColumnId[], [visibleKey]);
  const minWidth = rowWidth(columns);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const now = Date.now();
  const pinSet = new Set(pinned);
  const filtered = search.trim() !== '' || sectorFilter !== 'All' || flowFilter !== 'all';

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-surface-border bg-surface-raised">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2">
        <select
          value={sectorFilter}
          onChange={(e) => setSectorFilter(e.target.value)}
          className={cn(
            'h-7 rounded border bg-surface px-2 text-xs focus:outline-none',
            sectorFilter !== 'All' ? 'border-blue-500/60 text-slate-100' : 'border-surface-border text-slate-300',
          )}
          aria-label="Filter by sector"
        >
          <option value="All">All sectors</option>
          {SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex h-7 overflow-hidden rounded border border-surface-border" role="group" aria-label="Flow filter">
          {FLOW_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFlowFilter(f.value)}
              title={f.title}
              aria-pressed={flowFilter === f.value}
              className={cn(
                'px-2.5 text-[11px]',
                flowFilter === f.value ? 'bg-surface-overlay text-slate-100' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {search.trim() !== '' && (
          <button
            onClick={() => setSearch('')}
            className="flex h-7 items-center gap-1.5 rounded border border-blue-500/60 bg-blue-500/10 px-2 text-[11px] text-slate-200 hover:bg-blue-500/20"
            title="Clear the ticker filter"
          >
            Ticker: <span className="font-semibold uppercase">{search.trim()}</span>
            <span aria-hidden className="text-slate-400">✕</span>
          </button>
        )}
        {(sectorFilter !== 'All' || flowFilter !== 'all') && (
          <button
            onClick={() => {
              setSearch('');
              setSectorFilter('All');
              setFlowFilter('all');
            }}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto text-[11px] text-slate-500 tnum">
          {filtered ? `${rows.length} of ${totalRows}` : `${rows.length}`} tickers
        </span>
        <ColumnsMenu
          hidden={hidden}
          droppedForSpace={fit.droppedForSpace}
          onToggle={(id) => setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]))}
          onReset={() => setHidden([])}
        />
        {onTogglePanel && (
          <button
            onClick={onTogglePanel}
            className="flex h-7 items-center gap-1 rounded border border-surface-border px-2 text-[11px] text-slate-400 hover:text-slate-200"
            title={panelOpen ? 'Hide the side panel (more room for columns)' : 'Show the side panel (market, alerts, regime…)'}
            aria-pressed={panelOpen}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M15 4v16" />
            </svg>
            {panelOpen ? 'Hide panel' : 'Show panel'}
          </button>
        )}
      </div>

      {/* Header + body share one horizontal scroll context (only used when even the core columns don't fit). */}
      <div ref={wrapRef} className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div
          className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500"
          style={{ minWidth }}
        >
          {columns.map((id) => {
            const meta = COLUMN_META[id];
            const def = DEF_BY_ID.get(id);
            return (
              <button
                key={id}
                disabled={meta.sort === null}
                onClick={() => meta.sort && setSort(meta.sort)}
                title={meta.title}
                className={cn(
                  'shrink-0 whitespace-nowrap',
                  meta.align === 'right' ? 'text-right' : 'text-left',
                  meta.sort && 'hover:text-slate-300',
                  meta.sort === sortKey && 'text-slate-300',
                )}
                style={{ width: def?.width }}
              >
                {def?.label}
                {meta.sort !== null && meta.sort === sortKey && <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </button>
            );
          })}
        </div>

        {/* Virtualized body */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" style={{ minWidth }}>
          {isLoading && rows.length === 0 ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 12 }, (_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">
              {filtered ? 'No tickers match the current filters.' : 'No flow data yet — waiting for the first poll cycle.'}
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
                    <MemoRow row={row} pinned={pinSet.has(row.symbol)} flash={flash} columns={columns} />
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
