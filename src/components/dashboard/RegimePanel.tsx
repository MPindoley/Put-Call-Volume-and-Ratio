'use client';

/**
 * Regime-conditional accuracy (Phase 4.5). Renders /api/accuracy/regime:
 * warming-first, the signal×regime matrix (single names only — excess over the
 * regime-matched base rate as the headline, n prominent, Wilson CI, suppression),
 * a permanent exploratory banner with cells-tested / expected-by-chance, and the
 * separate tracks (event badge, backwardation by curve shape, ETF reference,
 * regime-detach). The original Accuracy tab is untouched.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Cell {
  signalType: string;
  regimeVol: string;
  regimeTrend: string;
  regimeGamma: string;
  n: number;
  hits: number;
  hitRate: number | null;
  baseRate: number | null;
  excess: number | null;
  avgRet: number | null;
  wilson: { lo: number; hi: number } | null;
  baseSource: string | null;
  suppressed: boolean;
}

interface RegimeResponse {
  demo?: boolean;
  warming: boolean;
  signalsLogged: number;
  signalsScored: number;
  firstScoringDate: string | null;
  matrix: { cells: Cell[]; cellsTested: number; suppressedCells: number; expectedByChance: number } | null;
  excludedByVersion: number;
  fullTripleFrom: string | null;
  eventTrack: { n: number; hits: number; hitRate: number | null; undershootBase: number | null; wilson: { lo: number; hi: number } | null } | null;
  backwardation: { resolution: string; n: number; avgCumReturnPct: number; outcomes: Record<string, number>; methods: Record<string, number> }[];
  backwardationOpen: number;
  regimeDetachLogged: number;
  etfTrack: { signalType: string; n: number; hits: number; hitRate: number; avgRet: number }[];
  dbRequired?: boolean;
}

const VOL = { pos: 'contango', neg: 'backwd', neutral: 'init', na: '–' } as Record<string, string>;
const TREND = { pos: '>50d', neg: '<50d', neutral: 'init', na: '–' } as Record<string, string>;
const GAMMA = { pos: '+γ', neg: '−γ', neutral: 'γ init', na: 'γ n/a' } as Record<string, string>;
const RESOLUTION = { front_collapse: 'front collapse (fear passed)', back_lift: 'back lift (fear repriced durable)', unknown: 'unknown' } as Record<string, string>;

const pctPt = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

export function RegimePanel(): JSX.Element {
  const [horizon, setHorizon] = useState<5 | 10 | 20>(10);
  const [basis, setBasis] = useState<'exSpy' | 'exSector' | 'raw'>('exSpy');
  const demo = typeof window !== 'undefined' && window.location.search.includes('demo=1');

  const query = useQuery({
    queryKey: ['regime-matrix', horizon, basis, demo],
    queryFn: async (): Promise<RegimeResponse> => {
      const res = await fetch(`/api/accuracy/regime?horizon=${horizon}&basis=${basis}${demo ? '&demo=1' : ''}`);
      if (res.status === 403) {
        // Demo refused (production guard) — fall back to the real payload.
        const real = await fetch(`/api/accuracy/regime?horizon=${horizon}&basis=${basis}`);
        return (await real.json()) as RegimeResponse;
      }
      if (!res.ok) throw new Error('regime fetch failed');
      return (await res.json()) as RegimeResponse;
    },
    refetchInterval: 300_000,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  const data = query.data;
  if (!data || data.dbRequired) {
    return (
      <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
        Regime-conditional accuracy needs the database connected (DATABASE_URL).
      </p>
    );
  }

  const byType = new Map<string, Cell[]>();
  for (const c of data.matrix?.cells ?? []) {
    const list = byType.get(c.signalType) ?? [];
    list.push(c);
    byType.set(c.signalType, list);
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      {data.demo && (
        <p className="rounded border border-caution/60 bg-caution/15 px-3 py-2 text-[11px] font-semibold text-caution">
          DEMO DATA — synthetic preview (blocked in production). Not real signal history.
        </p>
      )}

      {/* Permanent honesty banner. */}
      <p className="rounded border border-surface-border bg-surface px-3 py-2 text-[10px] leading-relaxed text-slate-500">
        <span className="font-semibold uppercase tracking-wide text-slate-400">Exploratory.</span> Overlapping forward
        windows are autocorrelated; with many cells some will look impressive by chance.
        {data.matrix &&
          ` ${data.matrix.cellsTested} cells tested — ~${data.matrix.expectedByChance} expected to clear a 95% CI by chance.`}
        {data.excludedByVersion > 0 && ` ${data.excludedByVersion} signals excluded (older threshold/regime version).`}
      </p>

      {/* Toggles + export. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded border border-surface-border">
          {([5, 10, 20] as const).map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={cn('px-2 py-1 text-[10px] tnum', horizon === h ? 'bg-blue-600/30 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
            >
              {h}d
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded border border-surface-border">
          {(
            [
              ['exSpy', 'vs SPY'],
              ['exSector', 'vs sector'],
              ['raw', 'raw'],
            ] as const
          ).map(([b, label]) => (
            <button
              key={b}
              onClick={() => setBasis(b)}
              className={cn('px-2 py-1 text-[10px]', basis === b ? 'bg-blue-600/30 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
              title="Hit is defined on the excess return; raw is the explicit toggle"
            >
              {label}
            </button>
          ))}
        </div>
        <a
          href={`/api/accuracy/regime?horizon=${horizon}&basis=${basis}&format=csv`}
          className="ml-auto rounded border border-surface-border px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200"
        >
          Export CSV
        </a>
      </div>

      {data.warming ? (
        <div className="rounded border border-surface-border bg-surface p-4">
          <p className="text-sm font-semibold text-slate-200">Warming</p>
          <p className="mt-1 leading-relaxed text-slate-400">
            {data.signalsLogged} signals logged · nothing is scoreable until 20 trading days elapse.
            {data.firstScoringDate && (
              <>
                {' '}
                First scoring available <span className="font-semibold text-slate-200">{data.firstScoringDate}</span>.
              </>
            )}
          </p>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            This is the correct state, not a failure — the matrix fills as forward windows complete.
            {data.fullTripleFrom && ` Full regime triple (incl. gamma) available from ${data.fullTripleFrom}; earlier signals score 2-D.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.fullTripleFrom && (
            <p className="text-[10px] text-slate-600">
              Full regime triple from {data.fullTripleFrom} — signals before that date appear in the γ n/a column.
            </p>
          )}
          {[...byType.entries()].map(([type, cells]) => (
            <div key={type} className="rounded border border-surface-border bg-surface">
              <p className="border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {type} <span className="ml-1 font-normal normal-case text-slate-600">single names only</span>
              </p>
              <div className="divide-y divide-surface-border/40">
                {cells.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="w-32 shrink-0 text-[10px] text-slate-400">
                      {VOL[c.regimeVol] ?? c.regimeVol} · {TREND[c.regimeTrend] ?? c.regimeTrend} ·{' '}
                      {GAMMA[c.regimeGamma] ?? c.regimeGamma}
                    </span>
                    <span className="w-14 shrink-0 tnum font-semibold text-slate-300">n={c.n}</span>
                    {c.suppressed ? (
                      <span className="text-[10px] text-slate-600">below min sample — stats suppressed</span>
                    ) : (
                      <>
                        <span
                          className={cn(
                            'w-16 shrink-0 tnum text-sm font-bold',
                            (c.excess ?? 0) > 0 ? 'text-bullish' : (c.excess ?? 0) < 0 ? 'text-bearish' : 'text-slate-300',
                          )}
                          title="Excess over the regime-matched base rate — the headline"
                        >
                          {c.excess !== null ? pctPt(c.excess) : '—'}
                        </span>
                        <span className="tnum text-[10px] text-slate-500">
                          hit {c.hitRate !== null ? pct(c.hitRate) : '—'}
                          {c.baseRate !== null && ` / base ${pct(c.baseRate)}`}
                          {c.baseSource && <sup className="ml-0.5 text-slate-600">{c.baseSource}</sup>}
                        </span>
                        {c.wilson && (
                          <span className="ml-auto tnum text-[10px] text-slate-600">
                            CI [{pct(c.wilson.lo)}–{pct(c.wilson.hi)}]
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Separate tracks — never part of the directional matrix. */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Separate tracks</p>

        <div className="rounded border border-surface-border bg-surface px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Event badge (rich/cheap vs realized)</p>
          {data.eventTrack ? (
            <p className="mt-1 tnum text-slate-300">
              hit {data.eventTrack.hitRate !== null ? pct(data.eventTrack.hitRate) : '—'} (n={data.eventTrack.n})
              {data.eventTrack.undershootBase !== null && (
                <span className="text-slate-500"> · unconditional undershoot base {pct(data.eventTrack.undershootBase)}</span>
              )}
              {data.eventTrack.wilson && (
                <span className="text-[10px] text-slate-600"> · CI [{pct(data.eventTrack.wilson.lo)}–{pct(data.eventTrack.wilson.hi)}]</span>
              )}
            </p>
          ) : (
            <p className="mt-1 text-[10px] text-slate-600">No scored events yet.</p>
          )}
        </div>

        <div className="rounded border border-surface-border bg-surface px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">
            Backwardation episodes <span className="tnum text-slate-600">({data.backwardationOpen} open)</span>
          </p>
          {data.backwardation.length > 0 ? (
            data.backwardation.map((b) => (
              <p key={b.resolution} className="mt-1 tnum text-[11px] text-slate-300">
                {RESOLUTION[b.resolution] ?? b.resolution}: n={b.n} · avg episode return {b.avgCumReturnPct >= 0 ? '+' : ''}
                {b.avgCumReturnPct}%
                <span className="ml-1 text-[10px] text-slate-600">
                  ({Object.entries(b.outcomes)
                    .map(([o, n]) => `${o} ${n}`)
                    .join(', ')}
                  {' · '}
                  {Object.entries(b.methods)
                    .map(([m, n]) => `${m} ${n}`)
                    .join('/')})
                </span>
              </p>
            ))
          ) : (
            <p className="mt-1 text-[10px] text-slate-600">No closed episodes yet.</p>
          )}
        </div>

        <div className="rounded border border-surface-border bg-surface px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">ETF signals (reference — hedging flow, not directional)</p>
          {data.etfTrack.length > 0 ? (
            data.etfTrack.map((e) => (
              <p key={e.signalType} className="mt-1 tnum text-[11px] text-slate-300">
                {e.signalType}: n={e.n} · hit {pct(e.hitRate)} · avg {(e.avgRet * 100).toFixed(2)}%
              </p>
            ))
          ) : (
            <p className="mt-1 text-[10px] text-slate-600">No scored ETF signals yet.</p>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            ETF/index put flow is structurally hedging, so these never enter the matrix.
          </p>
        </div>

        <p className="text-[10px] text-slate-600">regime-detach signals logged: {data.regimeDetachLogged} (magnitude analysis only)</p>
      </div>
    </div>
  );
}
