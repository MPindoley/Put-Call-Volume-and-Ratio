'use client';

/**
 * Time-of-day learning for one name:
 *  - its daily clock (intraday-profile.ts) — the share of a day's option volume
 *    it normally trades in each half hour — beside what its latest session did;
 *  - what has followed spike alerts (spike-outcomes.ts), by time of day and lean.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { IntradayResponse } from '@/app/api/flow/[symbol]/intraday/route';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Term } from '@/components/ui/term';
import type { ClockBucket, ClockReport } from '@/lib/intraday-jobs';
import type { RecentSpike, SpikeReport } from '@/lib/spike-outcome-jobs';
import { DAY_PARTS, HORIZON_LABEL, HORIZONS, LEANS, type BookLevel, type SpikeTable } from '@/lib/spike-outcomes';
import { cn, formatCompact } from '@/lib/utils';

const DAY_TYPE_LABEL = { regular: 'Regular day', expiry: 'Weekly-expiry day', earnings: 'Earnings day' } as const;
const PART_LABEL = { morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon' } as const;
const PART_HOURS = { morning: '9:30–11:00', midday: '11:00–2:00', afternoon: '2:00–close' } as const;
const LEAN_LABEL = { calls: 'Call-heavy', puts: 'Put-heavy' } as const;

/** "13:30" → "1:30". */
const twelveHour = (label: string): string => {
  const [h, m] = label.split(':');
  return `${((Number(h) + 11) % 12) + 1}:${m}`;
};
/** The half hour starting at a bucket label: "9:30–10:00". */
function halfHour(label: string): string {
  const [h, m] = label.split(':').map(Number) as [number, number];
  const end = h * 60 + m + 30;
  return `${twelveHour(label)}–${twelveHour(`${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}`)}`;
}
const pct = (v: number | null, digits = 0): string => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
const shortDate = (iso: string | null): string =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';

export function IntradayCards({ symbol }: { symbol: string }): JSX.Element {
  const q = useQuery({
    queryKey: ['intraday', symbol],
    queryFn: async (): Promise<IntradayResponse> => {
      const res = await fetch(`/api/flow/${symbol}/intraday`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as IntradayResponse;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: 1,
  });
  if (q.isLoading) {
    return (
      <Card>
        <CardHeader title="Time of day" />
        <div className="space-y-2 p-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader title="Time of day" />
        <p className="px-4 py-6 text-xs text-slate-500">Time-of-day learning could not be loaded.</p>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-12">
      <div className="min-w-0 xl:col-span-7">
        <ClockCard r={q.data.clock} />
      </div>
      <div className="min-w-0 xl:col-span-5">
        <SpikeCard r={q.data.spikes} />
      </div>
    </div>
  );
}

// ─── Daily clock ─────────────────────────────────────────────────────────────

const USUAL = '#64748b'; // context: the learned pattern
const SESSION = '#3b82f6'; // emphasis: what the session actually did

function ClockCard({ r }: { r: ClockReport }): JSX.Element {
  const [showTable, setShowTable] = useState(false);
  const firstHour = r.buckets[0]!.share + r.buckets[1]!.share;
  const lastHour = r.buckets[11]!.share + r.buckets[12]!.share;
  const sectorFirstHour = r.buckets[0]!.sectorShare + r.buckets[1]!.sectorShare;
  const busiest = r.buckets.reduce((a, b) => (b.share > a.share ? b : a));
  const lean = firstHour - sectorFirstHour;
  const pace = sessionPace(r);
  const putGap = biggestPutGap(r.buckets);
  const own = r.ownSessions.regular + r.ownSessions.expiry + r.ownSessions.earnings;

  return (
    <Card>
      <CardHeader
        title="Daily clock"
        right={
          <span className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] text-slate-400">
            {DAY_TYPE_LABEL[r.dayType]}
          </span>
        }
      />
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-slate-300">
          {r.learned ? (
            <>
              On a {DAY_TYPE_LABEL[r.dayType].toLowerCase()}, {r.symbol} usually trades{' '}
              <b className="text-slate-100">{pct(firstHour)}</b> of its <Term k="dailyClock">day&apos;s option volume</Term> in
              the first hour and <b className="text-slate-100">{pct(lastHour)}</b> in the last. Its busiest half hour is{' '}
              {halfHour(busiest.label)} ({pct(busiest.share)}).
              {Math.abs(lean) >= 0.02 && (
                <>
                  {' '}
                  That is {lean > 0 ? 'more' : 'less'} front-loaded than {r.sector === 'ETF' ? 'other ETFs' : `${r.sector} names`}{' '}
                  ({pct(sectorFirstHour)} in the first hour).
                </>
              )}
            </>
          ) : (
            <>
              Not learned yet — this is the starting curve every name begins with. Each finished session is folded in after the
              close, and the clock becomes {r.symbol}&apos;s own as sessions accumulate.
            </>
          )}
        </p>

        <ClockChart r={r} />

        {pace && (
          <p className="text-xs text-slate-300">
            {r.session && `${shortDate(r.session)}: `}
            <b className="text-slate-100">{formatCompact(pace.actual)}</b> contracts by {pace.by} —{' '}
            <b className="text-slate-100">{pace.multiple.toFixed(1)}×</b> its usual pace for that time (usually about{' '}
            {formatCompact(pace.expected)}).
          </p>
        )}
        {r.sessionGaps && (
          <p className="text-xs text-slate-500">
            The {shortDate(r.session)} session has a gap in its 5-minute data too wide to split into half hours, so only the usual
            pattern is shown.
          </p>
        )}
        {putGap && (
          <p className="text-xs text-slate-400">
            Put/call mix furthest from usual: {halfHour(putGap.label)} — {pct(putGap.actualPutShare)} puts against a usual{' '}
            {pct(putGap.putShare)}.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
          <span>
            {r.learned
              ? `${own} of ${r.symbol}'s own sessions on record (${r.ownSessions.regular} regular · ${r.ownSessions.expiry} expiry · ${r.ownSessions.earnings} earnings) — the regular clock is ${pct(r.ownShare)} its own pattern, the rest its sector's. Through ${shortDate(r.asOf)}.`
              : 'No sessions folded in yet.'}
          </span>
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="underline decoration-dotted hover:text-slate-300"
            aria-expanded={showTable}
          >
            {showTable ? 'Hide numbers' : 'Show numbers'}
          </button>
        </div>
        {showTable && <ClockTable r={r} />}
      </div>
    </Card>
  );
}

/** Session volume so far against what the clock expects by the same minute. */
function sessionPace(r: ClockReport): { actual: number; expected: number; multiple: number; by: string } | null {
  if (r.throughMin === null || r.avgDailyVolume === null || r.throughMin <= 0) return null;
  let actual = 0;
  let expected = 0;
  r.buckets.forEach((b, i) => {
    actual += b.actual ?? 0;
    expected += (b.expected ?? 0) * Math.min(1, Math.max(0, (r.throughMin! - i * 30) / 30));
  });
  if (!(expected > 0) || actual <= 0) return null;
  const m = 9 * 60 + 30 + Math.min(r.throughMin, 390);
  const by = r.throughMin >= 390 ? 'the close' : twelveHour(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
  return { actual, expected, multiple: actual / expected, by };
}

/** The finished half hour whose put share is furthest from usual (needs real volume to mean anything). */
function biggestPutGap(buckets: ClockBucket[]): ClockBucket | null {
  let best: ClockBucket | null = null;
  for (const b of buckets) {
    if (b.partial || b.putShare === null || b.actualPutShare === null || (b.actual ?? 0) < 100) continue;
    if (!best || Math.abs(b.actualPutShare - b.putShare) > Math.abs(best.actualPutShare! - best.putShare!)) best = b;
  }
  return best && Math.abs(best.actualPutShare! - best.putShare!) >= 0.1 ? best : null;
}

const W = 640;
const H = 190;
const PAD = { l: 34, r: 8, t: 10, b: 22 };

/**
 * Grouped columns per half hour on one axis — % of a normal day's volume:
 * the learned clock (gray, context) and the session shown (blue).
 */
function ClockChart({ r }: { r: ClockReport }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const avg = r.avgDailyVolume;
  const session = r.buckets.map((b) => (avg && b.actual !== null ? b.actual / avg : null));
  const hasSession = session.some((v) => v !== null);
  const peak = Math.max(...r.buckets.map((b) => b.share), ...session.map((v) => v ?? 0), 0.05);
  const step = peak > 0.6 ? 0.2 : peak > 0.3 ? 0.1 : 0.05;
  const top = Math.ceil(peak / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const band = plotW / r.buckets.length;
  const barW = Math.min(14, (band - 10) / 2);
  const y = (v: number): number => PAD.t + plotH * (1 - v / top);
  /** A column from the baseline, rounded at the data end only. */
  const column = (x: number, v: number): string => {
    const h = Math.max(0, plotH * (v / top));
    const rad = Math.min(3, h, barW / 2);
    const base = PAD.t + plotH;
    return `M${x},${base} V${base - h + rad} Q${x},${base - h} ${x + rad},${base - h} H${x + barW - rad} Q${x + barW},${base - h} ${x + barW},${base - h + rad} V${base} Z`;
  };
  const tip = hover === null ? null : r.buckets[hover]!;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: USUAL }} />
          Usual for this kind of day
        </span>
        {hasSession && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: SESSION }} />
            Session of {shortDate(r.session)}
          </span>
        )}
        <span className="ml-auto text-slate-500">
          <Term k="normalDayShare">% of a normal day&apos;s volume</Term>, per half hour (ET)
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${r.symbol} option volume by half hour: usual share of the day${hasSession ? ' beside the latest session' : ''}`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-surface-border" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-slate-500 text-[9px] tnum">
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          {r.buckets.map((b, i) => {
            const x0 = PAD.l + i * band + (band - (hasSession ? barW * 2 + 2 : barW)) / 2;
            const s = session[i] ?? null;
            return (
              <g key={b.label}>
                {hover === i && (
                  <rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} className="fill-surface-overlay" />
                )}
                <path d={column(x0, b.share)} fill={USUAL} />
                {s !== null && <path d={column(x0 + barW + 2, s)} fill={SESSION} opacity={b.partial ? 0.55 : 1} />}
                {i % 2 === 0 && (
                  <text x={PAD.l + i * band + band / 2} y={H - 7} textAnchor="middle" className="fill-slate-500 text-[9px] tnum">
                    {twelveHour(b.label)}
                  </text>
                )}
                {/* The whole band is the hover and focus target, not just the painted bars. */}
                <rect
                  x={PAD.l + i * band}
                  y={PAD.t}
                  width={band}
                  height={plotH + PAD.b}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${halfHour(b.label)}: usually ${pct(b.share, 1)} of the day${s !== null ? `, session ${pct(s, 1)}` : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                />
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} className="stroke-slate-600" strokeWidth={1} />
        </svg>
        {tip && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-52 rounded border border-surface-border bg-surface p-2 text-[11px] shadow-xl"
            style={
              hover < r.buckets.length / 2
                ? { left: `${((PAD.l + (hover + 1) * band) / W) * 100}%` }
                : { right: `${(1 - (PAD.l + hover * band) / W) * 100}%` }
            }
          >
            <p className="mb-1 font-semibold text-slate-200">
              {halfHour(tip.label)}
              {tip.partial && <span className="ml-1 font-normal text-slate-500">· in progress</span>}
            </p>
            <TipRow
              color={USUAL}
              label="Usual"
              value={`${pct(tip.share, 1)}${tip.expected !== null ? ` · ${formatCompact(tip.expected)}` : ''}`}
            />
            {tip.actual !== null && (
              <TipRow
                color={SESSION}
                label="Session"
                value={`${avg ? `${pct(tip.actual / avg, 1)} · ` : ''}${formatCompact(tip.actual)}${
                  tip.expected && !tip.partial ? ` · ${(tip.actual / tip.expected).toFixed(1)}×` : ''
                }`}
              />
            )}
            <TipRow label="Puts, usual" value={pct(tip.putShare)} />
            {tip.actualPutShare !== null && <TipRow label="Puts, session" value={pct(tip.actualPutShare)} />}
            <TipRow label={r.sector === 'ETF' ? 'ETFs usually' : 'Sector usually'} value={pct(tip.sectorShare, 1)} />
          </div>
        )}
      </div>
    </div>
  );
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }): JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-slate-400">
      {color ? (
        <span className="inline-block h-0.5 w-3 rounded" style={{ background: color }} />
      ) : (
        <span className="inline-block w-3" />
      )}
      <span>{label}</span>
      <span className="ml-auto font-semibold text-slate-100 tnum">{value}</span>
    </p>
  );
}

function ClockTable({ r }: { r: ClockReport }): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[11px] tnum">
        <thead className="text-left text-[10px] text-slate-500">
          <tr>
            <th className="py-1 pr-2 font-normal">Half hour (ET)</th>
            <th className="px-2 py-1 text-right font-normal">Usual share</th>
            <th className="px-2 py-1 text-right font-normal">Sector</th>
            <th className="px-2 py-1 text-right font-normal">All names</th>
            <th className="px-2 py-1 text-right font-normal">Usual contracts</th>
            <th className="px-2 py-1 text-right font-normal">Session</th>
            <th className="px-2 py-1 text-right font-normal">Puts usual</th>
            <th className="px-2 py-1 text-right font-normal">Puts session</th>
          </tr>
        </thead>
        <tbody>
          {r.buckets.map((b) => (
            <tr key={b.label} className="border-t border-surface-border/50 text-slate-300">
              <td className="py-1 pr-2">{halfHour(b.label)}</td>
              <td className="px-2 py-1 text-right">{pct(b.share, 1)}</td>
              <td className="px-2 py-1 text-right text-slate-500">{pct(b.sectorShare, 1)}</td>
              <td className="px-2 py-1 text-right text-slate-500">{pct(b.allShare, 1)}</td>
              <td className="px-2 py-1 text-right">{b.expected === null ? '—' : formatCompact(b.expected)}</td>
              <td className="px-2 py-1 text-right">
                {b.actual === null ? '—' : formatCompact(b.actual)}
                {b.partial && <span className="text-slate-600"> …</span>}
              </td>
              <td className="px-2 py-1 text-right">{pct(b.putShare)}</td>
              <td className="px-2 py-1 text-right">{pct(b.actualPutShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── After a spike ───────────────────────────────────────────────────────────

function SpikeCard({ r }: { r: SpikeReport }): JSX.Element {
  const [level, setLevel] = useState<BookLevel>('ticker');
  const table = r.tables.find((t) => t.level === level) ?? r.tables[0]!;
  const levelName = (l: BookLevel): string =>
    l === 'ticker' ? r.symbol : l === 'sector' ? r.sector : r.isEtf ? 'All ETFs' : 'All stocks';
  const learned = r.tables.some((t) => t.rows.some((row) => HORIZONS.some((h) => row.cells[h].rate !== null)));
  return (
    <Card>
      <CardHeader
        title="After a spike alert"
        right={
          <div className="flex gap-1" role="group" aria-label="Whose record">
            {r.tables.map((t) => (
              <button
                key={t.level}
                type="button"
                onClick={() => setLevel(t.level)}
                aria-pressed={t.level === level}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px]',
                  t.level === level
                    ? 'border-slate-500 bg-surface-overlay text-slate-100'
                    : 'border-surface-border text-slate-500 hover:text-slate-300',
                )}
              >
                {levelName(t.level)}
              </button>
            ))}
          </div>
        }
      />
      <div className="space-y-3 p-4">
        <p className="text-[11px] leading-relaxed text-slate-500">
          How often the price kept moving the way the spike leaned — <Term k="followThrough">follow-through</Term>, from the
          moment the alert appeared
          {r.isEtf ? '' : ', against SPY'}. 50% is a coin flip.
        </p>
        {learned ? (
          <SpikeTableView table={table} label={levelName(level)} />
        ) : (
          <p className="rounded border border-surface-border px-3 py-4 text-xs text-slate-400">
            Still learning: {r.episodes} spike alert{r.episodes === 1 ? '' : 's'} graded so far. Each row fills in once{' '}
            {r.minRoot} alerts of that kind (time of day × lean) have been graded across {r.isEtf ? 'all ETFs' : 'all stocks'}.
          </p>
        )}
        <RecentSpikes recent={r.recent} symbol={r.symbol} />
      </div>
    </Card>
  );
}

/** Time of day × lean down the side, the four windows across. Shared with the Learning page. */
export function SpikeTableView({ table, label }: { table: SpikeTable; label: string }): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-[11px] tnum">
        <thead className="text-left text-[10px] text-slate-500">
          <tr>
            <th className="py-1 pr-2 font-normal">Spike</th>
            {HORIZONS.map((h) => (
              <th key={h} className="px-2 py-1 text-right font-normal">
                {HORIZON_LABEL[h]}
              </th>
            ))}
            <th className="py-1 pl-2 text-right font-normal" title={`Graded spike alerts of this kind for ${label}`}>
              Graded
            </th>
          </tr>
        </thead>
        <tbody>
          {DAY_PARTS.flatMap((part) =>
            LEANS.map((lean) => {
              const row = table.rows.find((x) => x.part === part && x.lean === lean)!;
              return (
                <tr
                  key={`${part}-${lean}`}
                  className={cn(
                    'text-slate-300',
                    lean === 'calls' ? 'border-t border-surface-border' : 'border-t border-surface-border/30',
                  )}
                >
                  <td className="py-1 pr-2">
                    {lean === 'calls' ? (
                      <span title={PART_HOURS[part]}>
                        <span className="text-slate-200">{PART_LABEL[part]}</span>{' '}
                        <span className="text-slate-500">· {LEAN_LABEL[lean].toLowerCase()}</span>
                      </span>
                    ) : (
                      <span className="pl-3 text-slate-500">{LEAN_LABEL[lean].toLowerCase()}</span>
                    )}
                  </td>
                  {HORIZONS.map((h) => {
                    const c = row.cells[h];
                    if (c.rate === null) {
                      return (
                        <td
                          key={h}
                          className="px-2 py-1 text-right text-slate-600"
                          title="Not enough graded spikes of this kind yet"
                        >
                          —
                        </td>
                      );
                    }
                    const notable = Math.abs(c.rate - 0.5) >= 0.05;
                    return (
                      <td
                        key={h}
                        className={cn('px-2 py-1 text-right', notable ? 'font-semibold text-slate-100' : 'text-slate-400')}
                        title={`Learned ${(c.rate * 100).toFixed(1)}% · average move the spike's way ${c.avgMove! >= 0 ? '+' : ''}${c.avgMove!.toFixed(2)}% · ${c.n} graded for ${label}`}
                      >
                        {pct(c.rate)}
                        <span className="ml-1 text-[9px] font-normal text-slate-500">{c.rate >= 0.5 ? '▲' : '▼'}</span>
                      </td>
                    );
                  })}
                  <td className="py-1 pl-2 text-right text-slate-500">{row.n}</td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        ▲ kept going more often than not, ▼ faded; bold = at least 5 points from a coin flip. With few graded spikes of its own, a
        row mostly reflects the level above it (name → sector → all).
      </p>
    </div>
  );
}

const moveCell = (v: number | null, pending: boolean): JSX.Element =>
  v === null ? (
    <td className="px-2 py-1 text-right text-slate-600">{pending ? '…' : '—'}</td>
  ) : (
    <td className={cn('px-2 py-1 text-right', v > 0 ? 'text-bullish' : v < 0 ? 'text-bearish' : 'text-slate-400')}>
      {v > 0 ? '+' : ''}
      {v.toFixed(1)}%
    </td>
  );

function RecentSpikes({ recent, symbol }: { recent: RecentSpike[]; symbol: string }): JSX.Element {
  if (recent.length === 0) {
    return <p className="text-[11px] text-slate-500">No spike alerts on record for {symbol} yet.</p>;
  }
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        {symbol}&apos;s latest alerts — what the price did next
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[11px] tnum">
          <thead className="text-left text-[10px] text-slate-500">
            <tr>
              <th className="py-1 pr-2 font-normal">Alert (ET)</th>
              <th className="px-2 py-1 font-normal">Lean</th>
              <th className="px-2 py-1 text-right font-normal">30 min</th>
              <th className="px-2 py-1 text-right font-normal">2 hours</th>
              <th className="px-2 py-1 text-right font-normal">Close</th>
              <th className="px-2 py-1 text-right font-normal">Next day</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr key={a.at} className="border-t border-surface-border/50 text-slate-300">
                <td className="py-1 pr-2">
                  {new Date(a.at).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'America/New_York',
                  })}
                </td>
                <td className="px-2 py-1 text-slate-400">
                  {a.lean === 'calls' ? 'calls' : 'puts'} · {a.volumeMultiple.toFixed(1)}×
                </td>
                {moveCell(a.move30m, a.pending)}
                {moveCell(a.move2h, a.pending)}
                {moveCell(a.moveClose, a.pending)}
                {moveCell(a.moveNext, a.pending)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">
        The stock&apos;s own % move after each alert appeared. — = that window ran past the close or had no price on record.
      </p>
    </div>
  );
}
