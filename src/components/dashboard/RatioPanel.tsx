'use client';

/**
 * Aggregate put/call ratio: hero number + trend + historical context, sector
 * ratio chips, and a diverging heatmap of individual ticker ratios
 * (green < 1 < red with a neutral midpoint).
 */
import { useMemo } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCompact, formatRatio } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';

/** Diverging color for a P/C ratio: bullish green → neutral slate → bearish red. */
function ratioColor(ratio: number): string {
  const t = Math.max(-1, Math.min(1, Math.log2(Math.max(ratio, 0.05)))); // ±1 at ratio 0.5 / 2.0
  if (Math.abs(t) < 0.08) return 'rgba(100,116,139,0.35)';
  return t < 0
    ? `rgba(22,163,74,${0.15 + Math.abs(t) * 0.55})`
    : `rgba(239,68,68,${0.15 + Math.abs(t) * 0.55})`;
}

export function RatioPanel(): JSX.Element {
  const aggregate = useFlowStore((s) => s.aggregate);
  const sectors = useFlowStore((s) => s.sectors);
  const rows = useFlowStore((s) => s.rows);
  const market = useFlowStore((s) => s.market);

  const heatmap = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.sessionPutVolume + r.sessionCallVolume > 0)
        .sort((a, b) => b.sessionPutVolume + b.sessionCallVolume - (a.sessionPutVolume + a.sessionCallVolume))
        .slice(0, 60),
    [rows],
  );

  return (
    <Card>
      <CardHeader
        title="S&P 500 Put/Call Ratio"
        right={
          aggregate && (
            <span className="text-[10px] text-slate-500 tnum">
              {formatCompact(aggregate.putVolume)}P / {formatCompact(aggregate.callVolume)}C
            </span>
          )
        }
      />
      <div className="p-3">
        {!aggregate ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : (
          <>
            <div className="flex items-end gap-3">
              <span
                className={cn(
                  'text-5xl font-bold tnum leading-none',
                  aggregate.ratio > 1 ? 'text-bearish' : 'text-bullish',
                )}
              >
                {formatRatio(aggregate.ratio)}
              </span>
              <span
                className={cn(
                  'mb-1 text-sm tnum',
                  aggregate.trend > 0.005 ? 'text-bearish' : aggregate.trend < -0.005 ? 'text-bullish' : 'text-slate-500',
                )}
                title="Change vs ~15 minutes ago"
              >
                {aggregate.trend > 0.005 ? '▲' : aggregate.trend < -0.005 ? '▼' : '—'}{' '}
                {Math.abs(aggregate.trend).toFixed(3)}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {aggregate.ratio > 1 ? 'Put-dominant (defensive positioning)' : 'Call-dominant (risk-on positioning)'}
              {aggregate.vs20DayAvg !== null &&
                ` · ${aggregate.vs20DayAvg >= 0 ? '+' : ''}${(aggregate.vs20DayAvg * 100).toFixed(0)}% vs 20-day avg`}
              {aggregate.percentile !== null && ` · ${aggregate.percentile}th percentile`}
            </p>

            {/* Equity vs ETF split + VIX term structure */}
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
              {aggregate.equityRatio !== null && (
                <span
                  className="rounded border border-surface-border px-1.5 py-0.5 text-slate-300"
                  title="Single-name stocks only — the cleaner retail sentiment read"
                >
                  Equity-only{' '}
                  <span className={cn('tnum font-semibold', aggregate.equityRatio > 1 ? 'text-bearish' : 'text-bullish')}>
                    {formatRatio(aggregate.equityRatio)}
                  </span>
                </span>
              )}
              {aggregate.etfRatio !== null && (
                <span
                  className="rounded border border-surface-border px-1.5 py-0.5 text-slate-300"
                  title="ETF/index options — dominated by institutional hedging; reads differently"
                >
                  ETF/Index{' '}
                  <span className={cn('tnum font-semibold', aggregate.etfRatio > 1 ? 'text-bearish' : 'text-bullish')}>
                    {formatRatio(aggregate.etfRatio)}
                  </span>
                </span>
              )}
              {market?.vix != null && (
                <span
                  className="rounded border border-surface-border px-1.5 py-0.5 text-slate-300"
                  title={`VIX ${market.vix}${market.vix3m != null ? ` vs VIX3M ${market.vix3m}` : ''} — backwardation (VIX above VIX3M) signals acute stress; contango signals calm`}
                >
                  VIX <span className="tnum font-semibold">{market.vix.toFixed(1)}</span>
                  {market.vixSpread != null && (
                    <span className={cn('ml-1 font-semibold', market.vixSpread < 0 ? 'text-bearish' : 'text-bullish')}>
                      {market.vixSpread < 0 ? 'BACKWARDATION' : 'contango'} {market.vixSpread >= 0 ? '+' : ''}
                      {market.vixSpread.toFixed(1)}
                    </span>
                  )}
                </span>
              )}
            </div>

            {/* Sector ratios */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {sectors.slice(0, 8).map((s) => (
                <span
                  key={s.sector}
                  className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] text-slate-300"
                  title={`${s.sector}: ${formatCompact(s.putVolume)} puts / ${formatCompact(s.callVolume)} calls across ${s.tickerCount} tickers`}
                >
                  {s.sector}{' '}
                  <span className={cn('tnum font-semibold', s.ratio > 1 ? 'text-bearish' : 'text-bullish')}>
                    {formatRatio(s.ratio)}
                  </span>
                </span>
              ))}
            </div>

            {/* Ratio heatmap: top 60 by volume */}
            <div className="mt-3 grid grid-cols-10 gap-1" aria-label="Per-ticker put/call ratio heatmap">
              {heatmap.map((r) => (
                <a
                  key={r.symbol}
                  href={`/ticker/${r.symbol}`}
                  className="flex h-8 items-center justify-center rounded text-[9px] font-semibold text-slate-100 hover:ring-1 hover:ring-slate-400"
                  style={{ backgroundColor: ratioColor(r.putCallRatio) }}
                  title={`${r.symbol} — P/C ${formatRatio(r.putCallRatio)} · ${formatCompact(r.sessionPutVolume + r.sessionCallVolume)} contracts`}
                >
                  {r.symbol}
                </a>
              ))}
              {heatmap.length === 0 && (
                <p className="col-span-10 py-4 text-center text-xs text-slate-500">
                  Waiting for first flow data…
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
