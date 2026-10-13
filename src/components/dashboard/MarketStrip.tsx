'use client';

/**
 * One-row market summary above the scan table: the aggregate put/call ratio
 * with its trend and context, the equity-only vs ETF/index split, VIX term
 * structure, and the four index benchmarks. Replaces the old ratio card +
 * benchmark cards, which together pushed the table ~700px down the page.
 * Detail (intraday chart, sector ratios, heatmap) lives in the side panel's
 * Market tab.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { BENCHMARKS } from '@/lib/universe';
import { cn, formatCompact, formatRatio } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import { Sparkline } from './Sparkline';

const ratioTone = (r: number): string => (r > 1 ? 'text-bearish' : 'text-bullish');

function Cell({ label, title, children, className }: { label: ReactNode; title?: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex min-w-0 shrink-0 grow flex-col justify-center px-4 py-2', className)} title={title}>
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">{children}</div>
    </div>
  );
}

export function MarketStrip(): JSX.Element {
  const aggregate = useFlowStore((s) => s.aggregate);
  const market = useFlowStore((s) => s.market);
  const rows = useFlowStore((s) => s.rows);
  const series = useFlowStore((s) => s.ratioSeries);

  if (!aggregate) {
    return (
      <div className="flex h-[58px] items-center gap-6 rounded-lg border border-surface-border bg-surface-raised px-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  const trendUp = aggregate.trend > 0.005;
  const trendDown = aggregate.trend < -0.005;
  const context = [
    aggregate.ratio > 1 ? 'Put-dominant' : 'Call-dominant',
    aggregate.vs20DayAvg !== null ? `${aggregate.vs20DayAvg >= 0 ? '+' : ''}${(aggregate.vs20DayAvg * 100).toFixed(0)}% vs 20d` : null,
    aggregate.percentile !== null ? `${aggregate.percentile}th pct` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex items-stretch divide-x divide-surface-border overflow-x-auto rounded-lg border border-surface-border bg-surface-raised">
      <div
        className="flex shrink-0 items-center gap-3 px-4 py-2"
        title={`Aggregate put/call volume ratio across the tracked universe · ${formatCompact(aggregate.putVolume)} puts / ${formatCompact(aggregate.callVolume)} calls this session`}
      >
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Market P/C</p>
          <p className="flex items-baseline gap-2">
            <span className={cn('text-2xl font-bold leading-none tnum', ratioTone(aggregate.ratio))}>{formatRatio(aggregate.ratio)}</span>
            <span
              className={cn('text-xs tnum', trendUp ? 'text-bearish' : trendDown ? 'text-bullish' : 'text-slate-500')}
              title="Change vs ~15 minutes ago (rising = more defensive)"
            >
              {trendUp ? '▲' : trendDown ? '▼' : '—'} {Math.abs(aggregate.trend).toFixed(3)}
            </span>
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">{context}</p>
        </div>
        {series.length >= 2 && <Sparkline points={series.slice(-60).map((p) => p.ratio)} />}
      </div>

      {aggregate.equityRatio !== null && (
        <Cell label="Equity only" title="Single-name stocks only — the cleaner sentiment read">
          <span className={cn('text-base font-semibold tnum', ratioTone(aggregate.equityRatio))}>{formatRatio(aggregate.equityRatio)}</span>
        </Cell>
      )}
      {aggregate.etfRatio !== null && (
        <Cell label="ETF / Index" title="ETF and index options — dominated by institutional hedging, so it reads differently">
          <span className={cn('text-base font-semibold tnum', ratioTone(aggregate.etfRatio))}>{formatRatio(aggregate.etfRatio)}</span>
        </Cell>
      )}
      {market?.vix != null && (
        <Cell
          label="VIX"
          title={`VIX ${market.vix}${market.vix3m != null ? ` vs VIX3M ${market.vix3m}` : ''} — backwardation (VIX above VIX3M) signals acute stress; contango signals calm`}
        >
          <span className="text-base font-semibold tnum text-slate-100">{market.vix.toFixed(1)}</span>
          {market.vixSpread != null && (
            <span className={cn('text-[10px] font-semibold', market.vixSpread < 0 ? 'text-bearish' : 'text-slate-400')}>
              {market.vixSpread < 0 ? 'BACKWARDATION' : 'contango'} {market.vixSpread >= 0 ? '+' : ''}
              {market.vixSpread.toFixed(1)}
            </span>
          )}
        </Cell>
      )}

      {BENCHMARKS.map(({ symbol, label }) => {
        const row = rows[symbol];
        const live = row?.livePriceChangePct ?? null;
        const chg = live ?? (row && row.lastUpdated > 0 ? row.priceChangePct : null);
        return (
          <Link
            key={symbol}
            href={`/ticker/${symbol}`}
            prefetch={false}
            className="flex shrink-0 grow flex-col justify-center px-4 py-2 hover:bg-surface-overlay/50"
            title={
              row
                ? `${label} — P/C ${formatRatio(row.putCallRatio)} (5m) · ${formatCompact(row.sessionPutVolume)} puts / ${formatCompact(row.sessionCallVolume)} calls today` +
                  (chg !== null ? ` · ${live !== null ? 'live' : 'delayed chain'} move ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '')
                : label
            }
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              {symbol} <span className="normal-case tracking-normal text-slate-600">{label}</span>
            </p>
            {row && row.lastUpdated > 0 ? (
              <p className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
                <span className={cn('text-base font-semibold tnum', ratioTone(row.putCallRatio))}>{formatRatio(row.putCallRatio)}</span>
                {chg !== null && (
                  <span className={cn('text-[11px] tnum', chg >= 0 ? 'text-bullish' : 'text-bearish')}>
                    {chg >= 0 ? '+' : ''}
                    {chg.toFixed(2)}%
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-0.5 text-base text-slate-600">—</p>
            )}
          </Link>
        );
      })}
    </div>
  );
}
