'use client';

/**
 * Index benchmark strip: S&P 500 (SPY), NASDAQ-100 (QQQ), Dow 30 (DIA),
 * Russell 2000 (IWM) — P/C ratio, price change and ratio sparkline at a
 * glance, always visible above the flow table.
 */
import { BENCHMARKS } from '@/lib/universe';
import { cn, formatCompact, formatRatio } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import { Sparkline } from './Sparkline';

export function BenchmarkStrip(): JSX.Element {
  const rows = useFlowStore((s) => s.rows);

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {BENCHMARKS.map(({ symbol, label }) => {
        const row = rows[symbol];
        return (
          <a
            key={symbol}
            href={`/ticker/${symbol}`}
            className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 hover:border-slate-500"
          >
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {label} <span className="text-slate-600">({symbol})</span>
              </p>
              {row && row.lastUpdated > 0 ? (
                <p className="mt-0.5 flex items-baseline gap-2">
                  <span
                    className={cn(
                      'text-xl font-bold tnum leading-none',
                      row.putCallRatio > 1 ? 'text-bearish' : 'text-bullish',
                    )}
                  >
                    {formatRatio(row.putCallRatio)}
                  </span>
                  <span
                    className={cn(
                      'text-[11px] tnum',
                      row.priceChangePct >= 0 ? 'text-bullish' : 'text-bearish',
                    )}
                  >
                    {row.priceChangePct >= 0 ? '+' : ''}
                    {row.priceChangePct.toFixed(2)}%
                  </span>
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-slate-600">—</p>
              )}
              {row && (
                <p
                  className="text-[9px] text-slate-600 tnum"
                  title={`${formatCompact(row.sessionPutVolume)} puts / ${formatCompact(row.sessionCallVolume)} calls today`}
                >
                  {formatCompact(row.sessionPutVolume)}P / {formatCompact(row.sessionCallVolume)}C
                </p>
              )}
            </div>
            {row && <Sparkline points={row.ratioSparkline} />}
          </a>
        );
      })}
    </div>
  );
}
