'use client';

/**
 * Peer-group (cohort) health page. One row per peer cohort (benchmark ETF),
 * showing member count, member-IV IQR, the IV-dispersion proxy and its 90-day
 * percentile; weighting and composition version are audit columns shown on
 * request. The count + IQR are the health signals: they tell whether a name's
 * relative spread moved because the NAME moved or because its COHORT shifted
 * composition/dispersion. Below it, who leads whom.
 */
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { CollapsibleSection, useSections } from '@/components/ui/collapsible';
import { DetailToggle, useDetail } from '@/components/ui/more-detail';
import { Term } from '@/components/ui/term';
import type { LeadersReport } from '@/lib/sector-leader-jobs';
import type { LeaderRow } from '@/lib/sector-leaders';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shell/PageHeader';
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

  const sections = useSections('sectors.sections', DEFAULT_OPEN);
  const [audit, toggleAudit] = useDetail('cohort-audit');
  const rows = query.data ?? [];
  const ranked = rows.filter((d) => d.pct90 !== null);
  const stretched = ranked.filter((d) => d.pct90! >= 70 || d.pct90! <= 30).length;
  const cohortsHeadline = query.isLoading
    ? 'Loading…'
    : rows.length === 0
      ? 'Fills in after the first end-of-day capture'
      : ranked.length === 0
        ? `${rows.length} peer groups · the 90-day comparison is still building`
        : `${rows.length} peer groups · ${stretched === 0 ? 'none' : stretched} at an unusual reading for the last 90 days`;

  return (
    <div className="mx-auto max-w-7xl space-y-2 p-4 lg:p-6">
      <div className="pb-1">
        <PageHeader
          title="Cohorts — each stock's peer group"
          description={
            <>
              Every stock is compared against one group of peers: its sector, or its industry for some (semiconductors, biotech).
              This page shows whether each group is behaving like its usual self — which is what makes a stock&apos;s
              &ldquo;versus its sector&rdquo; readings trustworthy — and which names have tended to move before their group.
            </>
          }
        />
      </div>

      <CollapsibleSection
        id="cohorts"
        title="Peer groups"
        help="secCohorts"
        summary={cohortsHeadline}
        open={sections.isOpen('cohorts')}
        onToggle={() => sections.toggle('cohorts')}
      >
        {query.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">
            No finalized group data yet — groups populate after the first pinned end-of-day capture.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Group</th>
                    <th className="px-3 py-2 text-right">
                      <Term k="cohortMembers">Members</Term>
                    </th>
                    <th className="px-3 py-2 text-right">
                      <Term k="cohortIqr">IV spread</Term>
                    </th>
                    <th className="px-3 py-2 text-right">
                      <Term k="dispersionProxy">Dispersion proxy</Term>
                    </th>
                    <th className="px-3 py-2 text-right">
                      <Term k="dispersionPct">90-day percentile</Term>
                    </th>
                    {audit && (
                      <>
                        <th className="px-3 py-2 text-right">Weighting</th>
                        <th className="px-3 py-2 text-right">Days</th>
                        <th className="px-3 py-2 text-right">Membership version</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.cohort} className="border-t border-surface-border/50 text-slate-300">
                      <td className="px-3 py-2 font-medium text-slate-100">{d.label}</td>
                      <td className="px-3 py-2 text-right tnum">{d.constituentCount}</td>
                      <td className="px-3 py-2 text-right tnum">{d.medianIqr ?? '—'}</td>
                      <td className="px-3 py-2 text-right tnum">{d.proxy !== null ? d.proxy.toFixed(3) : '—'}</td>
                      <td className={cn('px-3 py-2 text-right tnum', pctClass(d.pct90))}>
                        {d.pct90 !== null ? `${d.pct90}%` : `${d.sampleDays}/20 days`}
                      </td>
                      {audit && (
                        <>
                          <td className="px-3 py-2 text-right text-slate-400">{d.weightMethod ?? '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-500">{d.sampleDays}</td>
                          <td className="px-3 py-2 text-right font-mono text-[10px] text-slate-600">{d.compositionVersion}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-surface-border px-3 py-2">
              <DetailToggle open={audit} onToggle={toggleAudit} label="the audit columns (weighting, days on record, membership version)" />
            </div>
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        id="leaders"
        title="Who leads whom"
        help="secLeaders"
        summary="Names whose positioning has tended to shift a session before their group moved"
        open={sections.isOpen('leaders')}
        onToggle={() => sections.toggle('leaders')}
      >
        <LeadersCard />
      </CollapsibleSection>
      <p className="pt-1 text-[10px] text-slate-500">
        Underlined terms and the ? beside each section explain themselves — hover, tab to them, or tap for what it is, how it is worked
        out and how to read it.
      </p>
    </div>
  );
}

/** A short page: both sections start open; closing one is remembered like everywhere else. */
const DEFAULT_OPEN = ['cohorts', 'leaders'] as const;

/**
 * Who leads whom (sector-leaders.ts): names whose option positioning has
 * tended to shift a session before their cohort moved against the market.
 */
function LeadersCard(): JSX.Element {
  const [cohort, setCohort] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['sector-leaders', cohort],
    queryFn: async (): Promise<LeadersReport> => {
      const res = await fetch(`/api/sectors/leaders${cohort ? `?cohort=${encodeURIComponent(cohort)}` : ''}`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as LeadersReport;
    },
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const r = q.data;
  const rows = (list: LeaderRow[]): JSX.Element => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-xs tnum">
        <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="py-1 font-normal">Name</th>
            <th className="py-1 text-right font-normal">Correlation</th>
            <th className="py-1 text-right font-normal">t</th>
            <th className="py-1 text-right font-normal">Sessions</th>
            <th className="py-1 pl-4 font-normal">Its positioning turning bullish has come before the group…</th>
          </tr>
        </thead>
        <tbody>
          {list.map((x) => (
            <tr key={x.symbol} className="border-t border-surface-border/50 text-slate-300">
              <td className="py-1 font-medium text-slate-100">
                <Link href={`/ticker/${x.symbol}`} prefetch={false} className="hover:underline">
                  {x.symbol}
                </Link>
              </td>
              <td className="py-1 text-right">
                {x.rho >= 0 ? '+' : ''}
                {x.rho.toFixed(2)}
              </td>
              <td className="py-1 text-right text-slate-400">{x.t.toFixed(1)}</td>
              <td className="py-1 text-right text-slate-500">{x.n}</td>
              <td className="py-1 pl-4 text-slate-400">
                {x.rho >= 0 ? 'beating the market the next session' : 'lagging the market the next session'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <Card>
      <CardHeader
        title="Who leads whom"
        right={
          r ? (
            <select
              aria-label="Cohort"
              value={r.cohort}
              onChange={(e) => setCohort(e.target.value)}
              className="rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200"
            >
              {r.cohorts.map((c) => (
                <option key={c.cohort} value={c.cohort}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
      {q.isLoading ? (
        <div className="p-3">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : q.isError || !r ? (
        <p className="px-4 py-6 text-xs text-slate-500">Needs the database: this is measured from stored end-of-day history.</p>
      ) : (
        <div className="space-y-3 p-4">
          <p className="text-[11px] leading-relaxed text-slate-500">
            For each name in the group: does a shift in its option positioning (
            <Term k="sectorLeader">the day&apos;s change in skew</Term>) tend to come a session before {r.cohort} moves against
            the market? Through {r.asOf ?? '—'}.
          </p>
          {r.tested === 0 ? (
            <p className="rounded border border-surface-border px-3 py-4 text-xs text-slate-400">
              Still learning: no name in this group has the {r.params.minObs} captured sessions this needs yet ({r.members}{' '}
              members).
            </p>
          ) : (
            <>
              {r.leaders.length > 0 ? (
                rows(r.leaders)
              ) : (
                <>
                  <p className="text-xs text-slate-300">No name clears the bar yet. The strongest so far, for reference only:</p>
                  {rows(r.strongest)}
                </>
              )}
              <p className="text-[10px] leading-relaxed text-slate-500">
                {r.tested} names tested; a name is listed past |t| {r.params.tCut}, a bar about {r.expectedByChance} of them would
                clear by chance alone.{' '}
                {r.leaders.length > 0 && r.leaders.length <= Math.ceil(r.expectedByChance)
                  ? 'That is no more than chance would produce, so treat these as candidates, not findings.'
                  : 'Exploratory: a correlation is not a mechanism, and it does not feed the learned lean.'}
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function pctClass(pct: number | null): string {
  if (pct === null) return 'text-slate-600';
  if (pct >= 70) return 'text-bearish';
  if (pct <= 30) return 'text-bullish';
  return 'text-slate-400';
}
