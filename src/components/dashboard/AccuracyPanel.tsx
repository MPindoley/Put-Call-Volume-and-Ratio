'use client';

/**
 * Alert accuracy scoreboard — the "evaluator" view. Shows how often alerts'
 * implied direction (put-heavy = bearish, call-heavy = bullish) matched the
 * underlying's move the next day, per severity level.
 */
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatTime } from '@/lib/utils';

interface AccuracyResponse {
  totalScored: number;
  overallHitRate: number | null;
  levels: { level: string; n: number; hitRate: number; avgMove: number; avgAbsMove: number }[];
  recent: {
    symbol: string;
    level: string;
    direction: 'bullish' | 'bearish';
    moveNextDay: number;
    hit: boolean;
    createdAt: number;
  }[];
  dbRequired?: boolean;
}

export function AccuracyPanel(): JSX.Element {
  const query = useQuery({
    queryKey: ['accuracy'],
    queryFn: async (): Promise<AccuracyResponse> => {
      const res = await fetch('/api/accuracy');
      if (!res.ok) throw new Error('accuracy fetch failed');
      return (await res.json()) as AccuracyResponse;
    },
    refetchInterval: 120_000,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  const data = query.data;
  if (!data || data.dbRequired) {
    return (
      <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
        Accuracy tracking needs the database connected (DATABASE_URL). Once it&apos;s up,
        every alert is scored against the next day&apos;s move automatically.
      </p>
    );
  }
  if (data.totalScored === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
        No scored alerts yet — alerts are graded ~1 trading day after they fire. Check
        back tomorrow.
      </p>
    );
  }

  return (
    <div className="p-3 text-xs">
      <div className="mb-3 rounded border border-surface-border bg-surface p-3">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Overall hit rate</p>
        <p className="mt-1 flex items-baseline gap-2">
          <span
            className={cn(
              'text-3xl font-bold tnum',
              (data.overallHitRate ?? 0) >= 55 ? 'text-bullish' : (data.overallHitRate ?? 0) >= 45 ? 'text-slate-200' : 'text-bearish',
            )}
          >
            {data.overallHitRate}%
          </span>
          <span className="text-slate-500 tnum">of {data.totalScored} scored alerts</span>
        </p>
        <p className="mt-1 text-[10px] text-slate-600">
          Hit = alert direction (put-heavy→down, call-heavy→up) matched the next day&apos;s move. ~50% ≈ coin flip.
        </p>
      </div>

      <table className="w-full">
        <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="py-1">Level</th>
            <th className="py-1 text-right">N</th>
            <th className="py-1 text-right">Hit rate</th>
            <th className="py-1 text-right">Avg move</th>
          </tr>
        </thead>
        <tbody>
          {data.levels.map((l) => (
            <tr key={l.level} className="border-t border-surface-border/50 text-slate-300">
              <td className="py-1.5 capitalize">{l.level}</td>
              <td className="py-1.5 text-right tnum">{l.n}</td>
              <td className={cn('py-1.5 text-right tnum font-semibold', l.hitRate >= 55 ? 'text-bullish' : l.hitRate < 45 ? 'text-bearish' : '')}>
                {l.hitRate}%
              </td>
              <td className="py-1.5 text-right tnum">±{l.avgAbsMove}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mb-1 mt-4 text-[10px] uppercase tracking-wider text-slate-500">Recently scored</p>
      <ul>
        {data.recent.map((r, i) => (
          <li key={i} className="flex items-center gap-2 border-t border-surface-border/40 py-1.5">
            <span className={cn('text-[10px]', r.hit ? 'text-bullish' : 'text-bearish')}>{r.hit ? '✓' : '✗'}</span>
            <a href={`/ticker/${r.symbol}`} className="font-semibold text-slate-200 hover:text-blue-400">
              {r.symbol}
            </a>
            <span className="text-slate-500">{r.direction}</span>
            <span className={cn('ml-auto tnum', r.moveNextDay >= 0 ? 'text-bullish' : 'text-bearish')}>
              {r.moveNextDay >= 0 ? '+' : ''}
              {r.moveNextDay.toFixed(1)}%
            </span>
            <span className="text-[10px] text-slate-600 tnum">{formatTime(r.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
