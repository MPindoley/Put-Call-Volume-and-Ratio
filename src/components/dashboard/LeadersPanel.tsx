'use client';

/** Session leaders: most unusual, biggest premium, strongest directional flow. */
import { useQuery } from '@tanstack/react-query';
import { SpikeBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCompact, formatPremium } from '@/lib/utils';
import type { SpikeLevel } from '@/types';

interface LeaderEntry {
  symbol: string;
  value: number;
  ratio: number;
  level: string;
}

interface SummaryResponse {
  asOf: number;
  alertsToday: number;
  topUnusual: LeaderEntry[];
  topPremium: LeaderEntry[];
  topBullish: LeaderEntry[];
  topBearish: LeaderEntry[];
}

function LeaderList({
  title,
  entries,
  render,
}: {
  title: string;
  entries: LeaderEntry[];
  render: (e: LeaderEntry) => string;
}): JSX.Element {
  return (
    <div className="mb-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{title}</p>
      {entries.length === 0 ? (
        <p className="py-2 text-[11px] text-slate-600">No data yet this session.</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={e.symbol} className="flex items-center gap-2 border-t border-surface-border/40 py-1.5 text-xs">
              <a href={`/ticker/${e.symbol}`} className="w-14 font-semibold text-slate-200 hover:text-blue-400">
                {e.symbol}
              </a>
              <SpikeBadge level={e.level as SpikeLevel} />
              <span className={cn('tnum', e.ratio > 1 ? 'text-bearish' : 'text-bullish')}>P/C {e.ratio.toFixed(2)}</span>
              <span className="ml-auto tnum text-slate-300">{render(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LeadersPanel(): JSX.Element {
  const query = useQuery({
    queryKey: ['summary'],
    queryFn: async (): Promise<SummaryResponse> => {
      const res = await fetch('/api/summary');
      if (!res.ok) throw new Error('summary fetch failed');
      return (await res.json()) as SummaryResponse;
    },
    refetchInterval: 60_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  const d = query.data;

  return (
    <div className="p-3">
      <LeaderList title="Most unusual (score)" entries={d.topUnusual} render={(e) => `${e.value}`} />
      <LeaderList title="Premium leaders (5m)" entries={d.topPremium} render={(e) => formatPremium(e.value)} />
      <LeaderList title="Strongest bullish flow" entries={d.topBullish} render={(e) => `+${formatCompact(e.value)}`} />
      <LeaderList title="Strongest bearish flow" entries={d.topBearish} render={(e) => formatCompact(e.value)} />
    </div>
  );
}
