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
      <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold text-slate-100">
        {symbol}
        {query.data?.flow.inverse && (
          <span
            className="rounded border border-caution/50 bg-caution/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-caution"
            title={`Inverse${query.data.flow.leverage !== 1 ? ` ${query.data.flow.leverage}×` : ''} product — sentiment is read in underlying-exposure terms (raw data untouched)`}
          >
            Inverse {query.data.flow.leverage !== 1 ? `${query.data.flow.leverage}×` : ''}
          </span>
        )}
        {!query.data?.flow.inverse && (query.data?.flow.leverage ?? 1) !== 1 && (
          <span className="rounded border border-surface-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {query.data?.flow.leverage}× leveraged
          </span>
        )}
      </h1>

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

/** Vol surface + positioning: IV context, skew, term structure, OI, GEX. */
function VolatilityCard({ flow }: { flow: TickerFlow }): JSX.Element | null {
  const a = flow.analytics;
  if (!a && flow.iv30 === null) return null;
  const ivHvSpread = flow.iv30 !== null && flow.hv20 !== null ? flow.iv30 - flow.hv20 : null;
  const maxOI = a ? Math.max(1, ...a.topStrikes.map((s) => s.putOI + s.callOI)) : 1;

  return (
    <Card>
      <CardHeader title="Volatility & Positioning" />
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="IV30" value={flow.iv30 !== null ? `${flow.iv30.toFixed(1)}` : '—'} />
        <Stat
          label="IV rank"
          value={flow.ivRank !== null ? `${flow.ivRank}` : '—'}
          className={(flow.ivRank ?? 0) >= 75 ? 'text-caution' : undefined}
        />
        <Stat label="HV20 (realized)" value={flow.hv20 !== null ? `${flow.hv20.toFixed(1)}` : '—'} />
        <Stat
          label="IV − HV spread"
          value={ivHvSpread !== null ? `${ivHvSpread >= 0 ? '+' : ''}${ivHvSpread.toFixed(1)}` : '—'}
          className={ivHvSpread !== null && ivHvSpread > 10 ? 'text-caution' : undefined}
        />
        {a && (
          <>
            <Stat
              label="25Δ risk reversal"
              value={a.rrSkew25 !== null ? `${a.rrSkew25 >= 0 ? '+' : ''}${a.rrSkew25.toFixed(1)}` : '—'}
              className={a.rrSkew25 !== null ? (a.rrSkew25 > 0 ? 'text-bullish' : a.rrSkew25 < -4 ? 'text-bearish' : undefined) : undefined}
            />
            <Stat
              label="Term structure"
              value={
                a.termSlope !== null
                  ? `${a.backwardated ? 'BACKWARDATED' : 'contango'} ${a.termSlope >= 0 ? '+' : ''}${a.termSlope.toFixed(1)}`
                  : '—'
              }
              className={a.backwardated ? 'text-bearish' : undefined}
            />
            <Stat label="Implied move (nearest exp)" value={a.impliedMovePct !== null ? `±${a.impliedMovePct.toFixed(1)}%` : '—'} />
            <Stat label="Likely catalyst expiry" value={a.eventExpiry ?? 'none detected'} />
            <Stat
              label="OI put/call"
              value={a.oiPutCall !== null ? a.oiPutCall.toFixed(2) : '—'}
              className={(a.oiPutCall ?? 1) > 1 ? 'text-bearish' : 'text-bullish'}
            />
            <Stat
              label="OI change (day)"
              value={flow.oiChangePct !== null ? `${flow.oiChangePct >= 0 ? '+' : ''}${flow.oiChangePct.toFixed(1)}%` : '—'}
            />
            <Stat label="Max pain (near exp)" value={a.maxPain !== null ? `$${a.maxPain}` : '—'} />
            <Stat
              label="Dealer gamma (est)"
              value={a.gexPer1Pct !== null ? `${a.gexPer1Pct >= 0 ? '+' : ''}${formatCompact(a.gexPer1Pct)}/1%` : '—'}
              className={a.gexPer1Pct !== null ? (a.gexPer1Pct >= 0 ? 'text-bullish' : 'text-bearish') : undefined}
            />
            <Stat label="LEAP IV (long-dated)" value={a.leapIv !== null ? a.leapIv.toFixed(1) : '—'} />
          </>
        )}
      </div>

      {a && a.topStrikes.length > 0 && (
        <div className="border-t border-surface-border px-4 py-3">
          <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
            Open-interest walls (top strikes — magnets/battlegrounds near expiry)
          </p>
          <div className="space-y-1">
            {a.topStrikes.map((s) => (
              <div key={s.strike} className="flex items-center gap-2 text-[11px]">
                <span className="w-16 text-right tnum text-slate-300">${s.strike}</span>
                <div className="flex h-3 flex-1 gap-0.5 overflow-hidden rounded-sm">
                  <div className="bg-bullish/70" style={{ width: `${(s.callOI / maxOI) * 100}%` }} title={`${formatCompact(s.callOI)} call OI`} />
                  <div className="bg-bearish/70" style={{ width: `${(s.putOI / maxOI) * 100}%` }} title={`${formatCompact(s.putOI)} put OI`} />
                </div>
                <span className="w-24 text-right tnum text-[10px] text-slate-500">
                  {formatCompact(s.callOI)}C / {formatCompact(s.putOI)}P
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {flow.oiSignals && (
        <div className="border-t border-surface-border px-4 py-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            OI flow (day) — OI change paired with same-side IV change
            {flow.inverse && <span className="ml-1 text-caution">· inverse: sides read as underlying exposure</span>}
          </p>
          <p
            className="mb-2 text-[10px] tnum text-slate-600"
            title="Per-side IV is decomposed as d(callIV)≈dIV+dSkew/2, d(putIV)≈dIV−dSkew/2 (ATM approximation). A large |dSkew| vs |dIV| means the per-side split is decomposition-heavy — audit those quadrant calls."
          >
            raw dIV {flow.oiSignals.iv30Change !== null ? `${flow.oiSignals.iv30Change >= 0 ? '+' : ''}${flow.oiSignals.iv30Change.toFixed(2)}` : '—'} ·
            dSkew {flow.oiSignals.skewChange !== null ? `${flow.oiSignals.skewChange >= 0 ? '+' : ''}${flow.oiSignals.skewChange.toFixed(2)}` : '—'}
            {thinDecomp(flow.oiSignals.iv30Change, flow.oiSignals.skewChange) && (
              <span className="ml-1 text-caution">· thin decomposition</span>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <OiSideRow label={flow.inverse ? 'Calls → underlying puts' : 'Calls'} side={flow.oiSignals.call} />
            <OiSideRow label={flow.inverse ? 'Puts → underlying calls' : 'Puts'} side={flow.oiSignals.put} />
          </div>
        </div>
      )}
    </Card>
  );
}

const OI_SIGNAL_STYLE: Record<string, { label: string; cls: string; hint: string }> = {
  demand: { label: 'Demand', cls: 'text-bullish', hint: 'OI up + IV up — new buyers paying up' },
  supply: { label: 'Supply', cls: 'text-bearish', hint: 'OI up + IV down — new sellers / overwriting' },
  unwind: { label: 'Unwind', cls: 'text-slate-400', hint: 'OI down + IV down — positions closing' },
  'short-cover': { label: 'Short cover', cls: 'text-caution', hint: 'OI down + IV up — closing buybacks' },
};

function OiSideRow({ label, side }: { label: string; side: import('@/types').SideFlow }): JSX.Element {
  const style = side.signal ? OI_SIGNAL_STYLE[side.signal] : null;
  return (
    <div className="rounded border border-surface-border bg-surface p-2">
      <p className="flex items-center justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        {style ? (
          <span className={cn('font-semibold', style.cls)} title={style.hint}>
            {style.label}
          </span>
        ) : (
          <span className="text-slate-600">flat / n/a</span>
        )}
      </p>
      <p className="mt-1 text-[10px] tnum text-slate-500">
        OI {side.oiChangePct !== null ? `${side.oiChangePct >= 0 ? '+' : ''}${side.oiChangePct.toFixed(1)}%` : '—'} · IV{' '}
        {side.ivChange !== null ? `${side.ivChange >= 0 ? '+' : ''}${side.ivChange.toFixed(2)}` : '—'}
      </p>
    </div>
  );
}

/** Sector-relative z-scores: how this name's spreads sit vs its sector, over time. */
function SectorRelativeCard({ flow }: { flow: TickerFlow }): JSX.Element {
  const r = flow.sectorRelative;
  const rows: { label: string; z30: number | null; z90: number | null; hint: string }[] = r
    ? [
        { label: 'Skew (25Δ RR)', z30: r.skewZ30, z90: r.skewZ90, hint: 'Positive = calls richer than sector; negative = puts richer' },
        { label: 'IV30', z30: r.ivZ30, z90: r.ivZ90, hint: 'Positive = IV elevated vs sector median' },
        { label: 'OI P/C', z30: r.oiPcZ30, z90: r.oiPcZ90, hint: 'Positive = more put-heavy positioning than sector' },
        { label: 'IV − HV', z30: r.ivHvZ30, z90: r.ivHvZ90, hint: 'Positive = richer vol premium than sector' },
      ]
    : [];

  return (
    <Card>
      <CardHeader
        title="Sector-Relative Positioning"
        right={
          r ? (
            <span className="flex items-center gap-2 text-[10px] text-slate-500 tnum">
              {r.cohortLabel && <span className="text-slate-400">vs {r.cohortLabel}</span>}
              <span>{r.windowDays >= 90 ? '90/90 days' : `accumulating ${r.windowDays}/90`}</span>
            </span>
          ) : undefined
        }
      />
      {!r ? (
        <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
          Sector-relative z-scores appear after the first pinned end-of-day capture. Each metric&apos;s
          (ticker − sector median) spread is scored against its own 30/90-day history.
        </p>
      ) : (
        <>
          {r.regimeDetach && (
            <p className="border-b border-caution/30 bg-caution/10 px-4 py-2 text-[11px] text-caution">
              Regime shift: {r.regimeDetachMetric} relative spread has {r.regimeDetachDir} vs sector
              (30-day baseline detached from the 90-day).
            </p>
          )}
          {r.divergence && (
            <p
              className={cn(
                'border-b px-4 py-2 text-[11px]',
                r.divergence === 'distribution' ? 'border-bearish/30 bg-bearish/10 text-bearish' : 'border-bullish/30 bg-bullish/10 text-bullish',
              )}
              title={
                `Heuristic filter, not a significance test — overlapping daily obs are autocorrelated, so the OLS t is inflated. ` +
                `OLS t: price ${fmtT(r.priceTrendT)}, skew-z ${fmtT(r.skewTrendT)}. ` +
                `Newey-West HAC t (audit): price ${fmtT(r.priceTrendTNW)}, skew-z ${fmtT(r.skewTrendTNW)}.`
              }
            >
              {r.divergence === 'distribution'
                ? 'Distribution warning: price trending up while skew-z is deteriorating (positioning turning defensive vs the move).'
                : 'Accumulation warning: price trending down/flat while skew-z is improving (positioning quietly turning constructive).'}
              {flow.inverse && ' (translated to underlying exposure — inverse product.)'}
              <span className="ml-1 opacity-70">heuristic screen · hover for HAC t</span>
            </p>
          )}
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-1.5">Metric (vs sector median)</th>
                <th className="px-4 py-1.5 text-right">z30</th>
                <th className="px-4 py-1.5 text-right">z90</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-surface-border/50 text-slate-300" title={row.hint}>
                  <td className="px-4 py-2">{row.label}</td>
                  <td className={cn('px-4 py-2 text-right tnum', zClass(row.z30))}>{fmtZ(row.z30)}</td>
                  <td className={cn('px-4 py-2 text-right tnum', zClass(row.z90))}>{fmtZ(row.z90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-surface-border px-4 py-2 text-[10px] leading-relaxed text-slate-600">
            Read relative, not absolute: index/ETF puts are structurally bid from hedging, so a single
            name&apos;s skew is meaningful against its sector, not against zero. |z| ≥ 2 is a notable
            deviation from that name&apos;s own norm.
          </p>
        </>
      )}
    </Card>
  );
}

function fmtZ(z: number | null): string {
  return z === null ? '—' : `${z >= 0 ? '+' : ''}${z.toFixed(2)}`;
}
function fmtT(t: number | null): string {
  if (t === null) return '—';
  if (!Number.isFinite(t)) return t > 0 ? '+∞' : '−∞';
  return `${t >= 0 ? '+' : ''}${t.toFixed(2)}`;
}
/** Flag a per-side IV decomposition as "thin" when |dSkew| dominates |dIV|. */
function thinDecomp(dIv: number | null, dSkew: number | null): boolean {
  if (dIv === null || dSkew === null) return false;
  return Math.abs(dSkew) > 2 * Math.abs(dIv) && Math.abs(dSkew) > 0.5;
}
function zClass(z: number | null): string {
  if (z === null) return 'text-slate-600';
  if (z >= 1) return 'text-bearish';
  if (z <= -1) return 'text-bullish';
  return 'text-slate-400';
}

function EventGaugeCard({ flow }: { flow: TickerFlow }): JSX.Element | null {
  const g = flow.eventGauge;
  if (!g) return null;
  const sourceLabel: Record<string, string> = {
    manual: 'manual (confirmed)',
    forward: 'forward-confirmed',
    bulge: 'IV bulge (unconfirmed)',
  };
  const timingLabel: Record<string, string> = {
    bmo: 'before open',
    amc: 'after close',
    unknown: 'timing unknown',
  };
  const pct = (v: number | null): string => (v === null ? '—' : `±${(v * 100).toFixed(1)}%`);
  const richCheap =
    g.percentile === null
      ? null
      : g.percentile >= 70
        ? { text: 'RICH', cls: 'text-bearish' }
        : g.percentile <= 30
          ? { text: 'CHEAP', cls: 'text-bullish' }
          : { text: 'fair', cls: 'text-slate-300' };

  return (
    <Card>
      <CardHeader title="Event / earnings implied move" />
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat
          label="Implied event move"
          value={pct(g.impliedMove)}
          className={g.impliedMove !== null ? 'text-slate-100' : undefined}
        />
        <Stat label="Clean diffusive vol" value={g.diffusiveVol !== null ? `${(g.diffusiveVol * 100).toFixed(1)}` : '—'} />
        <Stat
          label="Extraction"
          value={g.impliedMethod === 'pre-event-reference' ? 'pre-event ref' : g.impliedMethod === 'two-post-event' ? 'two post-event' : '—'}
        />
        <Stat
          label="Catalyst"
          value={g.eventDate ?? 'none'}
          className={g.eventSource === 'bulge' ? 'text-caution' : undefined}
        />
      </div>

      {g.eventDate && (
        <p className="px-4 pb-1 text-[10px] tnum text-slate-500">
          source: {g.eventSource ? (sourceLabel[g.eventSource] ?? g.eventSource) : '—'}
          {g.reportTiming ? ` · ${timingLabel[g.reportTiming] ?? g.reportTiming}` : ''}
        </p>
      )}

      {g.refusedReason && (
        <p className="mx-4 mb-3 rounded border border-caution/30 bg-caution/10 px-3 py-2 text-[11px] leading-relaxed text-caution">
          Decomposition refused (not clamped): {g.refusedReason}
        </p>
      )}

      <div className="border-t border-surface-border px-4 py-3">
        {g.display ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Rich/cheap vs confirmed realized history</span>
              {richCheap && (
                <span className={cn('font-semibold', richCheap.cls)}>
                  {richCheap.text}
                  {g.percentile !== null && <span className="ml-1 text-[10px] text-slate-500">({g.percentile}th pctile)</span>}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px] tnum text-slate-400 sm:grid-cols-3">
              <span>median realized {pct(g.medianRealized)}</span>
              <span>implied/median {g.richCheapRatio !== null ? `${g.richCheapRatio.toFixed(2)}×` : '—'}</span>
              <span>{g.confirmedCount} confirmed events</span>
            </div>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Insufficient confirmed history — {g.confirmedCount}/{g.requiredCount} confirmed events. The rich/cheap read
            stays hidden (not a number) until enough manual or forward-confirmed earnings reactions accrue; the
            distribution builds itself quarter by quarter.
          </p>
        )}
      </div>
    </Card>
  );
}

function IdiosyncraticCard({ flow }: { flow: TickerFlow }): JSX.Element | null {
  const moves = flow.idiosyncraticMoves;
  if (!moves || moves.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Idiosyncratic moves (unscheduled, vs SPY)" />
      <p className="px-4 pt-3 text-[10px] leading-relaxed text-slate-500">
        Large single-name moves not explained by the broad market — earnings, launches, analyst actions, headlines.
        Informational; not an earnings source.
      </p>
      <div className="px-4 pb-3 pt-2">
        <div className="space-y-1">
          {moves.map((m) => (
            <div key={m.date} className="flex items-center gap-3 text-[11px] tnum">
              <span className="w-24 text-slate-300">{m.date}</span>
              <span className={cn('w-16 text-right font-semibold', m.movePct >= 0.05 ? 'text-caution' : 'text-slate-300')}>
                ±{(m.movePct * 100).toFixed(1)}%
              </span>
              <span className="text-slate-500">{m.residualZ.toFixed(1)}σ residual</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
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

      <VolatilityCard flow={flow} />
      <SectorRelativeCard flow={flow} />
      <EventGaugeCard flow={flow} />
      <IdiosyncraticCard flow={flow} />

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
