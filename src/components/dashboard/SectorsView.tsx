'use client';

/**
 * Cohort median-health page. One row per peer cohort (benchmark ETF), showing
 * the IV-dispersion proxy, its 90-day percentile, member count and member-IV
 * IQR, plus the composition version. The count + IQR are the health signals:
 * they let you tell whether a name's relative spread moved because the NAME
 * moved or because its COHORT shifted composition/dispersion.
 */
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { SectorDispersion } from '@/types';

interface FlowResponse {
  dispersions: SectorDispersion[];
}

export function SectorsView(): JSX.Element {
  const query = useQuery({
    queryKey: ['sectors'],
    queryFn: async (): Promise<SectorDispersion[]> => {
      const res = await fetch('/api/flow');
      if (!res.ok) throw new Error('fetch failed');
      return ((await res.json()) as FlowResponse).dispersions;
    },
    refetchInterval: 60_000,
  });

  return (
    <div className="mx-auto max-w-5xl p-4">
      <a href="/" className="text-xs text-slate-500 hover:text-slate-300">
        ← Back to dashboard
      </a>
      <h1 className="mt-2 text-2xl font-bold text-slate-100">Cohort Health</h1>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
        Each peer cohort is keyed by its benchmark ETF. Names overridden to an industry ETF
        (semis → SMH, biotech → XBI) belong to that cohort only and leave their GICS sector
        median — one name, one peer group. The <strong>IV dispersion proxy</strong> is benchmark
        IV ÷ weighted-average member IV (a proxy, not implied correlation). Member <strong>count</strong>{' '}
        and member-IV <strong>IQR</strong> are the health signals: a moving spread with a stable
        cohort means the name moved; a shifting count/IQR means the cohort itself changed.
      </p>

      <Card className="mt-4">
        <CardHeader title="Cohorts" />
        {query.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : !query.data || query.data.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">
            No finalized cohort data yet — cohorts populate after the first pinned end-of-day capture.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2">Cohort</th>
                  <th className="px-3 py-2 text-right">Members</th>
                  <th className="px-3 py-2 text-right">IV IQR</th>
                  <th className="px-3 py-2 text-right">Dispersion proxy</th>
                  <th className="px-3 py-2 text-right">90d pctile</th>
                  <th className="px-3 py-2 text-right">Weighting</th>
                  <th className="px-3 py-2 text-right">Days</th>
                  <th className="px-3 py-2 text-right">Comp. ver.</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((d) => (
                  <tr key={d.cohort} className="border-t border-surface-border/50 text-slate-300">
                    <td className="px-3 py-2 font-medium text-slate-100">{d.label}</td>
                    <td className="px-3 py-2 text-right tnum">{d.constituentCount}</td>
                    <td className="px-3 py-2 text-right tnum">{d.medianIqr ?? '—'}</td>
                    <td className="px-3 py-2 text-right tnum">{d.proxy !== null ? d.proxy.toFixed(3) : '—'}</td>
                    <td className={cn('px-3 py-2 text-right tnum', pctClass(d.pct90))}>
                      {d.pct90 !== null ? `${d.pct90}%` : `${d.sampleDays}/20`}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-400">{d.weightMethod ?? '—'}</td>
                    <td className="px-3 py-2 text-right tnum text-slate-500">{d.sampleDays}</td>
                    <td className="px-3 py-2 text-right font-mono text-[10px] text-slate-600">{d.compositionVersion}</td>
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

function pctClass(pct: number | null): string {
  if (pct === null) return 'text-slate-600';
  if (pct >= 70) return 'text-bearish';
  if (pct <= 30) return 'text-bullish';
  return 'text-slate-400';
}
