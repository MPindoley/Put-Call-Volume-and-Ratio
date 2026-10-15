'use client';

/**
 * The learning page: what the app has learned about its own signals, whether
 * its data is healthy, and — the honesty check — whether its learned
 * convictions have actually been right. Every figure carries a plain-language
 * line; absence of evidence is shown as such, never as a number.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/shell/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import type { Calibration, SignalSummary } from '@/lib/learning';
import type { LearningReport } from '@/lib/learning-jobs';
import type { Coverage, HorizonKey } from '@/lib/projection-history';
import { Term } from '@/components/ui/term';
import { cn } from '@/lib/utils';

interface SummaryResponse {
  version: string;
  books: number;
  learning: {
    asOf: string;
    reconstructed: boolean;
    rowsUsed: number;
    rowsUnbased: number;
    signals: SignalSummary[];
  } | null;
}

const SIGNAL_NAMES: Record<string, string> = {
  skew_z: 'Skew z-score',
  divergence: 'Price / skew divergence',
  pc_extreme: 'OI put/call extreme',
  spike_alert: 'Volume spike',
};
const REGIME_NAMES: Record<string, string> = {
  'pos|pos': 'calm vol · uptrend',
  'pos|neg': 'calm vol · downtrend',
  'neg|pos': 'stressed vol · uptrend',
  'neg|neg': 'stressed vol · downtrend',
};

const pts = (x: number | null | undefined, digits = 1): string =>
  x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}`;
const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export function LearningView(): JSX.Element {
  const summary = useQuery({ queryKey: ['learning'], queryFn: () => getJson<SummaryResponse>('/api/learning'), refetchInterval: 300_000 });
  const report = useQuery({
    queryKey: ['learning-report'],
    queryFn: () => getJson<LearningReport>('/api/learning/report'),
    refetchInterval: 300_000,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4 lg:p-6">
      <PageHeader
        title="What the app has learned"
        description={
          <>
            Every signal is graded 10 trading sessions after it fires: did the stock beat the market in the direction the signal
            pointed, more often than it does with no signal at all? Each night the app updates what that record says, leaning
            hard on small samples toward &ldquo;no edge&rdquo; until the evidence earns more. Then it grades itself.
          </>
        }
      />

      {report.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : report.isError || !report.data ? (
        <Card>
          <p className="p-4 text-xs text-slate-400">
            No learning report yet. It needs a connected database and at least one captured session; it appears after the first
            nightly run.
          </p>
        </Card>
      ) : (
        <StatusCard r={report.data} />
      )}

      <LearnedCard data={summary.data} loading={summary.isLoading} />

      {report.data && <SelfGradeCard c={report.data.selfGrade} />}
      <ProjectionRecordCard />
      {report.data && <HealthCard r={report.data} />}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-lg font-semibold tnum text-slate-100">{value}</p>
      {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

function StatusCard({ r }: { r: LearningReport }): JSX.Element {
  const s = r.status;
  const est = s.established;
  const estN = est ? est.signal.established + est.regime.established + est.sector.established + est.ticker.established : 0;
  const estT = est ? est.signal.total + est.regime.total + est.sector.total + est.ticker.total : 0;
  return (
    <Card>
      <CardHeader title="How much it knows" />
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
        <Tile
          label="Sessions captured"
          value={String(s.captured.count)}
          sub={
            (s.captured.first ? `${s.captured.first} → ${s.captured.last}` : 'first at the next close') +
            ` · ${s.sessions.count} days of price history`
          }
        />
        <Tile label="Signals graded" value={s.signals.graded.toLocaleString()} sub={`of ${s.signals.logged.toLocaleString()} logged`} />
        <Tile
          label="Awaiting grades"
          value={s.signals.pending.toLocaleString()}
          sub={s.signals.nextMaturity ? `next due ${s.signals.nextMaturity}` : 'none pending'}
        />
        <Tile label="Nightly snapshots" value={String(s.books.total)} sub={`${s.books.live} live · ${s.books.reconstructed} rebuilt`} />
        <Tile label="Established estimates" value={`${estN} / ${estT}`} sub="earned ≥ half their own weight" />
      </div>
      {est && (
        <p className="border-t border-surface-border px-4 py-2 text-[10px] leading-relaxed text-slate-500">
          Established by level — signal {est.signal.established}/{est.signal.total} · regime {est.regime.established}/
          {est.regime.total} · sector {est.sector.established}/{est.sector.total} · stock {est.ticker.established}/{est.ticker.total}.
          Deeper levels need more history before they count; a stock-level estimate needs roughly 80 graded signals to stand on
          its own.
        </p>
      )}
    </Card>
  );
}

function LearnedCard({ data, loading }: { data: SummaryResponse | undefined; loading: boolean }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <Skeleton className="h-40 w-full" />;
  const l = data?.learning;
  return (
    <Card>
      <CardHeader title={l ? `Signal by signal (as of ${l.asOf})` : 'Signal by signal'} />
      {!l || l.signals.length === 0 ? (
        <p className="p-4 text-xs text-slate-400">
          Nothing graded yet under the current signal definitions. A signal is graded 10 sessions after it fires.
        </p>
      ) : (
        <div className="p-4">
          <table className="w-full text-xs tnum">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-1 font-normal">Signal</th>
                <th className="py-1 text-right font-normal">Graded</th>
                <th className="py-1 text-right font-normal" title="Hit rate above base rate, straight from the data (unshrunk)">
                  Raw record
                </th>
                <th className="py-1 text-right font-normal" title="Share of the estimate this signal's own evidence earned">
                  Confidence
                </th>
                <th className="py-1 text-right font-normal" title="Learned edge: points above base, ± approximate standard error">
                  Learned edge
                </th>
              </tr>
            </thead>
            <tbody>
              {l.signals.map((s) => {
                const key = `${s.signalType}|${s.direction}`;
                const expanded = open === key;
                return (
                  <SignalRows key={key} s={s} expanded={expanded} toggle={() => setOpen(expanded ? null : key)} />
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
            <span className="text-slate-400">How to read this:</span> &ldquo;+4.0 pts&rdquo; means the signal lands on the predicted
            side 4 percentage points more often than the stock does on an ordinary day in the same market conditions. Zero means no
            demonstrated edge. Click a signal to see it by market regime.
            {l.rowsUnbased > 0 && ` ${l.rowsUnbased} graded signals had no base rate to compare against and were left out rather than guessed.`}
          </p>
        </div>
      )}
    </Card>
  );
}

function SignalRows({ s, expanded, toggle }: { s: SignalSummary; expanded: boolean; toggle: () => void }): JSX.Element {
  const tone = Math.abs(s.edge) < 0.01 ? 'text-slate-400' : s.edge > 0 ? 'text-bullish' : 'text-bearish';
  return (
    <>
      <tr className="cursor-pointer border-t border-surface-border/50 text-slate-300 hover:bg-surface-overlay" onClick={toggle}>
        <td className="py-1.5">
          <span className="mr-1 text-slate-600">{expanded ? '▾' : '▸'}</span>
          {SIGNAL_NAMES[s.signalType] ?? s.signalType}{' '}
          <span className={s.direction === 'bullish' ? 'text-bullish' : 'text-bearish'}>{s.direction}</span>
        </td>
        <td className="py-1.5 text-right">{s.n.toLocaleString()}</td>
        <td className="py-1.5 text-right text-slate-400">{pts(s.raw)}</td>
        <td className="py-1.5 text-right">
          <span className="inline-block h-1.5 rounded-sm bg-slate-400/60 align-middle" style={{ width: `${Math.round(s.evidence * 48)}px` }} />{' '}
          {pct(s.evidence)}
        </td>
        <td className={cn('py-1.5 text-right font-semibold', tone)}>
          {pts(s.edge)} <span className="font-normal text-slate-500">± {(s.se * 100).toFixed(1)}</span>
        </td>
      </tr>
      {expanded &&
        s.regimes.map((r) => (
          <tr key={r.regime} className="text-[11px] text-slate-400">
            <td className="py-0.5 pl-6">{REGIME_NAMES[r.regime] ?? r.regime}</td>
            <td className="py-0.5 text-right">{r.n.toLocaleString()}</td>
            <td className="py-0.5 text-right">{pts(r.raw)}</td>
            <td className="py-0.5 text-right">{pct(r.evidence)}</td>
            <td className="py-0.5 text-right">{pts(r.edge)}</td>
          </tr>
        ))}
    </>
  );
}

function SelfGradeCard({ c }: { c: Calibration }): JSX.Element {
  return (
    <Card>
      <CardHeader title="Is it getting better? (self-grading)" />
      {c.n === 0 ? (
        <p className="p-4 text-xs leading-relaxed text-slate-400">
          No graded convictions yet. A conviction is graded 10 sessions after it&apos;s shown, and only once there was enough
          learned evidence to lean at all — so this fills in after the first weeks of graded history.
        </p>
      ) : (
        <div className="space-y-4 p-4">
          <p className="text-sm leading-relaxed text-slate-200">
            When the app leaned, it was right <span className="font-semibold">{pct(c.hitRate)}</span> of the time against an
            ordinary-day rate of <span className="font-semibold">{pct(c.base)}</span> — a realized edge of{' '}
            <span className={cn('font-semibold', (c.realized ?? 0) > 0 ? 'text-bullish' : 'text-bearish')}>{pts(c.realized)} pts</span>{' '}
            {c.ci && (
              <span className="text-slate-500">
                (95% range {pts(c.ci.lo)} to {pts(c.ci.hi)})
              </span>
            )}{' '}
            versus the <span className="font-semibold">{pts(c.predicted)} pts</span> it claimed, over {c.n.toLocaleString()} graded
            calls.
          </p>
          <p className="text-xs text-slate-400">
            Skill score{' '}
            <span className={cn('font-semibold tnum', (c.skill ?? 0) > 0 ? 'text-bullish' : 'text-bearish')}>
              {c.skill === null ? '—' : c.skill.toFixed(3)}
            </span>
            {' — '}
            {c.skill === null
              ? 'not computable yet.'
              : c.skill > 0
                ? 'above zero: its leans carried information beyond simply knowing each stock’s usual behaviour.'
                : 'at or below zero: so far its leans have not beaten simply knowing each stock’s usual behaviour. That is the system telling the truth, not a fault in it.'}
          </p>

          {c.bins.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Did strong calls deliver more than weak ones?</p>
              <table className="w-full text-xs tnum">
                <thead className="text-left text-[10px] uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="py-1 font-normal">Claimed</th>
                    <th className="py-1 text-right font-normal">Calls</th>
                    <th className="py-1 text-right font-normal">Claimed avg</th>
                    <th className="py-1 text-right font-normal">Delivered</th>
                    <th className="py-1 text-right font-normal">95% range</th>
                  </tr>
                </thead>
                <tbody>
                  {c.bins.map((b) => (
                    <tr key={b.label} className="border-t border-surface-border/50 text-slate-300">
                      <td className="py-1">{b.label}</td>
                      <td className="py-1 text-right">{b.n}</td>
                      <td className="py-1 text-right">{pts(b.predicted)}</td>
                      <td className={cn('py-1 text-right font-semibold', b.realized > 0 ? 'text-bullish' : 'text-bearish')}>{pts(b.realized)}</td>
                      <td className="py-1 text-right text-slate-500">{b.ci ? `${pts(b.ci.lo)} … ${pts(b.ci.hi)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-slate-500">
                Well calibrated means &ldquo;delivered&rdquo; tracks &ldquo;claimed&rdquo;. Delivering much less means it is overconfident.
              </p>
            </div>
          )}

          {c.byMonth.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Month by month</p>
              <div className="space-y-0.5">
                {c.byMonth.map((m) => (
                  <div key={m.month} className="flex gap-4 text-[11px] tnum text-slate-300">
                    <span className="w-16 text-slate-400">{m.month}</span>
                    <span className="w-20 text-right">{m.n} calls</span>
                    <span className="w-28 text-right">claimed {pts(m.predicted)}</span>
                    <span className={cn('w-28 text-right', m.realized > 0 ? 'text-bullish' : 'text-bearish')}>delivered {pts(m.realized)}</span>
                    <span className="text-slate-500">skill {m.skill === null ? '—' : m.skill.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function HealthCard({ r }: { r: LearningReport }): JSX.Element {
  const s = r.status;
  return (
    <Card>
      <CardHeader title="Data health" />
      <div className="space-y-2 p-4 text-xs text-slate-300">
        <p>
          <span className="tnum font-semibold">{s.signals.unbased}</span> graded signals left out because no base rate could be
          established (they are skipped, never guessed).
        </p>
        <p>
          <span className="tnum font-semibold">{s.signals.excludedFrozen}</span> signals left out because they fired on — or were
          graded against — a frozen price (a halted or delisted stock&apos;s last price, repeated).
        </p>
        {s.frozen.names > 0 ? (
          <div>
            <p className="text-slate-400">
              {s.frozen.names} stock{s.frozen.names === 1 ? '' : 's'} with frozen-price stretches (excluded from learning):
            </p>
            <div className="mt-1 space-y-0.5">
              {s.frozen.top.map((f) => (
                <p key={f.symbol} className="tnum text-[11px] text-slate-400">
                  <span className="inline-block w-14 text-slate-200">{f.symbol}</span>
                  {f.sessions} sessions · {f.from} → {f.to}
                </p>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-slate-500">No frozen-price stretches found.</p>
        )}
        <p className="pt-1 text-[10px] text-slate-600">Learning version {r.version} · report generated {r.generatedAt.slice(0, 16).replace('T', ' ')} UTC</p>
      </div>
    </Card>
  );
}

interface ProjectionCoverageResponse {
  all: Record<HorizonKey, Coverage> | null;
  bySector: Record<string, Record<HorizonKey, Coverage>>;
}

/**
 * The projection's own report card: one market-implied range per name per
 * week, graded with the settled close at expiry. A fair 68% range holds about
 * 68% of the time; consistently more means options overprice moves, and the
 * low/high split shows which way the misses fall.
 */
function ProjectionRecordCard(): JSX.Element {
  const q = useQuery({
    queryKey: ['projection-coverage'],
    queryFn: () => getJson<ProjectionCoverageResponse>('/api/projection'),
    refetchInterval: 300_000,
  });
  const pctOf = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  const rows: { label: string; c: Record<HorizonKey, Coverage> }[] = q.data
    ? [
        ...(q.data.all ? [{ label: 'All names', c: q.data.all }] : []),
        ...Object.entries(q.data.bySector).map(([label, c]) => ({ label, c })),
      ]
    : [];
  const any = rows.some((r) => r.c.week.n + r.c.month.n > 0);
  return (
    <Card>
      <CardHeader title="Projection track record — did prices land where options said?" />
      {!any ? (
        <p className="p-4 text-xs text-slate-400">
          No graded projections yet. Each week the end-of-day capture logs every name&apos;s ~1-week and ~1-month implied ranges;
          they are graded with the settled close on their expiry date.
        </p>
      ) : (
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[560px] text-xs tnum">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-1 font-normal" />
                <th className="py-1 text-right font-normal">~1 week: graded</th>
                <th className="py-1 text-right font-normal">
                  in <Term k="range68">68%</Term>
                </th>
                <th className="py-1 text-right font-normal">missed low / high</th>
                <th className="py-1 text-right font-normal">~1 month: graded</th>
                <th className="py-1 text-right font-normal">in 68%</th>
                <th className="py-1 text-right font-normal">in 95%</th>
                <th className="py-1 text-right font-normal">
                  <Term k="adjustedRange">adjusted 68%</Term>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ label, c }) => (
                <tr key={label} className={cn('border-t border-surface-border/50', label === 'All names' ? 'text-slate-100' : 'text-slate-300')}>
                  <td className="py-1">{label}</td>
                  <td className="py-1 text-right">{c.week.n}</td>
                  <td className="py-1 text-right">{pctOf(c.week.inside68)}</td>
                  <td className="py-1 text-right text-slate-500">
                    {pctOf(c.week.below68)} / {pctOf(c.week.above68)}
                  </td>
                  <td className="py-1 text-right">{c.month.n}</td>
                  <td className="py-1 text-right">{pctOf(c.month.inside68)}</td>
                  <td className="py-1 text-right">{pctOf(c.month.inside95)}</td>
                  <td className="py-1 text-right">{c.month.calibratedN > 0 ? pctOf(c.month.calibratedInside68) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
            A fair 68% range holds about 68% of the time. Consistently higher means option prices overstate real moves (the usual
            premium for protection); the low/high split shows which side the misses fall on. The adjusted column checks the
            history-adjusted range on the projections that carried one.
          </p>
        </div>
      )}
    </Card>
  );
}
