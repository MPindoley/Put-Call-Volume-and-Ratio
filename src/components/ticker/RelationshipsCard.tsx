'use client';

/**
 * How this stock's options data moves (relationships.ts): which measurements
 * have come before moves in the stock, which move together day to day, and
 * the past setups most like today's with what followed them.
 */
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Term } from '@/components/ui/term';
import type { GlossaryKey } from '@/lib/glossary';
import type { RelationshipsReport } from '@/lib/relationship-jobs';
import { FEATURES, type FeatureKey, type LeadStats } from '@/lib/relationships';
import { cn } from '@/lib/utils';

const FEATURE_TERM: Record<FeatureKey, GlossaryKey> = {
  skewZ: 'skewZ',
  ivZ: 'ivZ',
  oiPcZ: 'oiPcZ',
  ivHvZ: 'ivHvZ',
  ivRank: 'ivRankFeature',
  termSlope: 'termSlope',
  volRatio: 'volRatio',
  mom5: 'mom5',
};
const SHORT: Record<FeatureKey | 'ret', string> = {
  skewZ: 'Skew z',
  ivZ: 'IV z',
  oiPcZ: 'OI P/C z',
  ivHvZ: 'Vol prem z',
  ivRank: 'IV rank',
  termSlope: 'Term',
  volRatio: 'Volume',
  mom5: '5d move',
  ret: 'Stock vs SPY',
};
const LABEL = Object.fromEntries(FEATURES.map((f) => [f.key, f.label])) as Record<FeatureKey, string>;

/** A log return as a plain percentage change. */
const retPct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${((Math.exp(v) - 1) * 100).toFixed(1)}%`);
const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const fmtFeature = (k: FeatureKey, v: number | undefined): string => {
  if (v === undefined) return '—';
  if (k === 'mom5') return retPct(v);
  if (k === 'volRatio') return `${v.toFixed(2)}×`;
  if (k === 'ivRank') return v.toFixed(0);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
};

export function RelationshipsCard({ symbol }: { symbol: string }): JSX.Element {
  const q = useQuery({
    queryKey: ['relationships', symbol],
    queryFn: async (): Promise<RelationshipsReport> => {
      const res = await fetch(`/api/flow/${symbol}/relationships`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as RelationshipsReport;
    },
    staleTime: 10 * 60_000,
    retry: 1,
  });

  return (
    <Card>
      <CardHeader
        title="How this stock's data moves"
        right={
          q.data ? (
            <span className="text-[10px] tnum text-slate-500">
              through {q.data.asOf ?? '—'} · {q.data.tickerSessions} sessions · {q.data.sectorNames} {q.data.sector} names
            </span>
          ) : undefined
        }
      />
      {q.isLoading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : q.isError || !q.data ? (
        <p className="px-4 py-6 text-xs text-slate-500">
          Needs the database: relationships are measured from stored end-of-day history (this stock and its sector peers).
        </p>
      ) : (
        <div className="space-y-5 p-4">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Every finalized session is a snapshot of eight measurements plus what the stock did over the next 10 sessions against
            SPY. As history accumulates, this shows which measurements have tended to come before moves, which move together, and
            what followed setups like today&apos;s. Exploratory: every figure shows how much history it rests on.
          </p>
          <Leads report={q.data} />
          <Analogs report={q.data} />
          <Matrix report={q.data} />
        </div>
      )}
    </Card>
  );
}

function LeadCell({ s, min }: { s: LeadStats | null; min: number }): JSX.Element {
  if (!s) return <td className="px-2 py-1 text-right text-slate-600" title={`Needs ${min}+ sessions with known outcomes`}>warming</td>;
  return (
    <td className="px-2 py-1 text-right">
      <span
        className={cn('font-semibold', s.notable ? (s.rho! > 0 ? 'text-bullish' : 'text-bearish') : 'text-slate-400')}
        title={`ρ ${s.rho} · t ${s.t ?? '—'} (n/10 effective) · n ${s.n}`}
      >
        {s.rho === null ? '—' : `${s.rho >= 0 ? '+' : ''}${s.rho.toFixed(2)}`}
      </span>
      <span className="ml-1.5 text-slate-500">
        {pct(s.top.beat)} / {pct(s.bottom.beat)}
      </span>
      <span className="ml-1.5 text-[10px] text-slate-600">n {s.n}</span>
    </td>
  );
}

function Leads({ report }: { report: RelationshipsReport }): JSX.Element {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        What has come before moves — vs the <Term k="excess10">next 10 sessions vs SPY</Term>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[11px] tnum">
          <thead className="text-left text-[10px] text-slate-500">
            <tr>
              <th className="py-1 pr-2 font-normal">Measurement</th>
              <th className="px-2 py-1 text-right font-normal">
                This stock: <Term k="spearman">ρ</Term> · <Term k="topBottomFifth">beat SPY top / bottom fifth</Term>
              </th>
              <th className="px-2 py-1 text-right font-normal">Sector pool</th>
            </tr>
          </thead>
          <tbody>
            {report.leads.map((row) => (
              <tr key={row.key} className="border-t border-surface-border/50 text-slate-300">
                <td className="py-1 pr-2">
                  <Term k={FEATURE_TERM[row.key]}>{row.label}</Term>
                </td>
                <LeadCell s={row.ticker} min={40} />
                <LeadCell s={row.sector} min={100} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-slate-600">
        Coloured = notable (<Term k="leadT">|t| ≥ 2</Term> after allowing for overlapping windows). Green: higher values have come
        before the stock beating SPY; red: before it lagging.
      </p>
    </div>
  );
}

function Analogs({ report }: { report: RelationshipsReport }): JSX.Element {
  const a = report.analogs;
  const s = a.summary;
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Term k="analogs">Similar past setups</Term>
        {a.today && <span className="normal-case"> — matching {a.today.date}</span>}
      </p>
      {a.today && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {FEATURES.map((f) => (
            <span key={f.key} className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] tnum text-slate-400">
              {SHORT[f.key]} <span className="text-slate-200">{fmtFeature(f.key, a.today?.features[f.key])}</span>
            </span>
          ))}
          {a.today.regime && (
            <span className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] text-slate-400">
              regime <span className="text-slate-200">{a.today.regime}</span>
            </span>
          )}
        </div>
      )}
      {!s ? (
        <p className="text-[11px] text-slate-500">{a.reason ?? 'Not enough history yet.'}</p>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-slate-200">
            After the <span className="font-semibold">{s.n}</span> past setups most like today&apos;s, the stock beat SPY over the next
            10 sessions <span className="font-semibold tnum">{pct(s.beat)}</span> of the time
            {s.beatCi && (
              <span className="text-[11px] text-slate-500">
                {' '}
                (95% interval {pct(s.beatCi.lo)}–{pct(s.beatCi.hi)})
              </span>
            )}{' '}
            — against <span className="tnum">{pct(s.baseBeat)}</span> for all {a.pool.toLocaleString()} comparable past sessions.
          </p>
          <p className="mt-1 text-[11px] tnum text-slate-500">
            Typical outcome {retPct(s.median)} vs SPY (middle half {retPct(s.q1)} to {retPct(s.q3)}); all sessions {retPct(s.baseMedian)} ·
            average <Term k="analogDistance">distance</Term> {s.avgDistance.toFixed(2)}
          </p>
          <div className="mt-2 max-h-56 overflow-auto">
            <table className="w-full text-[11px] tnum">
              <thead className="sticky top-0 bg-surface-raised text-left text-[10px] text-slate-500">
                <tr>
                  <th className="py-1 font-normal">Date</th>
                  <th className="py-1 font-normal">Stock</th>
                  <th className="py-1 text-right font-normal">Distance</th>
                  <th className="py-1 text-right font-normal">Next 10 sessions vs SPY</th>
                </tr>
              </thead>
              <tbody>
                {a.analogs.map((x) => (
                  <tr key={`${x.symbol}|${x.date}`} className="border-t border-surface-border/50 text-slate-300">
                    <td className="py-0.5">{x.date}</td>
                    <td className={cn('py-0.5', x.symbol === report.symbol && 'text-slate-100')}>{x.symbol}</td>
                    <td className="py-0.5 text-right text-slate-500">{x.distance.toFixed(2)}</td>
                    <td className={cn('py-0.5 text-right', x.fwd > 0 ? 'text-bullish' : 'text-bearish')}>{retPct(x.fwd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Matrix({ report }: { report: RelationshipsReport }): JSX.Element {
  const m = report.coMovement;
  const any = m.rho.some((row, i) => row.some((v, j) => i !== j && v !== null));
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Term k="coMovement">Moves together</Term> — daily changes, this stock
      </p>
      {!any ? (
        <p className="text-[11px] text-slate-500">Needs 30+ consecutive finalized sessions of this stock&apos;s measurements.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[10px] tnum">
            <thead>
              <tr>
                <th />
                {m.keys.map((k) => (
                  <th key={k} className="px-1 pb-1 text-center font-normal text-slate-500">
                    <span className="block w-14 leading-tight">{SHORT[k]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.keys.map((a, i) => (
                <tr key={a}>
                  <th className="whitespace-nowrap pr-2 text-right font-normal text-slate-500">{SHORT[a]}</th>
                  {m.keys.map((b, j) => {
                    const v = m.rho[i]![j]!;
                    const bg =
                      v === null || i === j ? 'transparent' : v > 0 ? `rgba(59,130,246,${Math.min(0.85, Math.abs(v))})` : `rgba(239,68,68,${Math.min(0.85, Math.abs(v))})`;
                    return (
                      <td
                        key={b}
                        className="h-7 w-14 border border-surface text-center text-slate-200"
                        style={{ background: bg }}
                        title={
                          v === null
                            ? `${a === 'ret' ? 'Stock vs SPY' : LABEL[a as FeatureKey]} × ${b === 'ret' ? 'Stock vs SPY' : LABEL[b as FeatureKey]}: not enough pairs (${m.n[i]![j]})`
                            : `${a === 'ret' ? 'Stock vs SPY' : LABEL[a as FeatureKey]} × ${b === 'ret' ? 'Stock vs SPY' : LABEL[b as FeatureKey]}: ρ ${v.toFixed(2)} over ${m.n[i]![j]} days`
                        }
                      >
                        {i === j ? '' : v === null ? '·' : v.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
