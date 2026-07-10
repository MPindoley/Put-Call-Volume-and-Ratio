'use client';

/**
 * Single-ticker view: live flow stats plus stored 5-minute history (ratio and
 * volume) when the database is connected.
 */
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { SpikeBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/components/dashboard/Sparkline';
import { cn, formatCompact, formatPremium, formatRatio, formatTime } from '@/lib/utils';
import type { TickerFlow } from '@/types';

interface HistoryPoint {
  bucketStart: string;
  putVolume: number;
  callVolume: number;
  putCallRatio: number;
  spikeScore: number;
}

interface DetailResponse {
  flow: TickerFlow;
  history: HistoryPoint[];
}

export function TickerDetail({ symbol }: { symbol: string }): JSX.Element {
  const query = useQuery({
    queryKey: ['ticker', symbol],
    queryFn: async (): Promise<DetailResponse> => {
      const res = await fetch(`/api/flow/${symbol}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'not-tracked' : 'fetch-failed');
      return (await res.json()) as DetailResponse;
    },
    refetchInterval: 15_000,
    retry: 1,
  });

  return (
    <div className="mx-auto max-w-4xl p-4">
      <a href="/" className="text-xs text-slate-500 hover:text-slate-300">
        ← Back to dashboard
      </a>
      <h1 className="mt-2 text-2xl font-bold text-slate-100">{symbol}</h1>

      {query.isLoading ? (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError || !query.data ? (
        <p className="mt-6 text-sm text-slate-400">
          {query.error instanceof Error && query.error.message === 'not-tracked'
            ? `${symbol} is not in the tracked universe (edit src/lib/universe.ts to add it).`
            : 'Failed to load ticker data — retrying automatically.'}
        </p>
      ) : (
        <TickerBody data={query.data} />
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }): JSX.Element {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={cn('text-lg font-semibold tnum text-slate-100', className)}>{value}</p>
    </div>
  );
}

function TickerBody({ data }: { data: DetailResponse }): JSX.Element {
  const { flow, history } = data;
  return (
    <div className="mt-4 space-y-3">
      <Card>
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Stat
            label="Put/Call ratio (5m)"
            value={formatRatio(flow.putCallRatio)}
            className={flow.putCallRatio > 1 ? 'text-bearish' : 'text-bullish'}
          />
          <Stat label="Puts 5m / session" value={`${formatCompact(flow.putVolume)} / ${formatCompact(flow.sessionPutVolume)}`} />
          <Stat label="Calls 5m / session" value={`${formatCompact(flow.callVolume)} / ${formatCompact(flow.sessionCallVolume)}`} />
          <Stat label="Premium 5m" value={formatPremium(flow.putPremium + flow.callPremium)} />
          <Stat
            label="Underlying"
            value={flow.underlyingPrice > 0 ? `$${flow.underlyingPrice.toFixed(2)}` : '—'}
            className={flow.priceChangePct >= 0 ? 'text-bullish' : 'text-bearish'}
          />
          <Stat label="Vol vs expected" value={`${flow.volumeVsExpected.toFixed(1)}×`} />
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Unusual activity</p>
            <p className="mt-1 flex items-center gap-2">
              <SpikeBadge level={flow.spikeLevel} />
              <span className="text-lg font-semibold tnum text-slate-100">{flow.spikeScore}</span>
            </p>
          </div>
          <Stat label="Updated" value={flow.lastUpdated > 0 ? `${formatTime(flow.lastUpdated)} ET` : '—'} />
        </div>
        <div className="border-t border-surface-border px-4 py-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">P/C ratio — last 30 min</p>
          <Sparkline points={flow.ratioSparkline} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Stored 5-min history (30 days)" />
        {history.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">
            No stored history — connect a database (DATABASE_URL) to accumulate snapshots for backtesting.
          </p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-raised text-left text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-1.5">Bucket</th>
                  <th className="px-3 py-1.5 text-right">Puts</th>
                  <th className="px-3 py-1.5 text-right">Calls</th>
                  <th className="px-3 py-1.5 text-right">P/C</th>
                  <th className="px-3 py-1.5 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(-100).reverse().map((h) => (
                  <tr key={h.bucketStart} className="border-t border-surface-border/50 text-slate-300">
                    <td className="px-3 py-1">{new Date(h.bucketStart).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right tnum">{formatCompact(h.putVolume)}</td>
                    <td className="px-3 py-1 text-right tnum">{formatCompact(h.callVolume)}</td>
                    <td className={cn('px-3 py-1 text-right tnum', h.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')}>
                      {formatRatio(h.putCallRatio)}
                    </td>
                    <td className="px-3 py-1 text-right tnum">{h.spikeScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
