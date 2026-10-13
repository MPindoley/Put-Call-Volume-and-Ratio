'use client';

/**
 * Single-ticker view: live flow stats plus stored 5-minute history (ratio and
 * volume) when the database is connected.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { SpikeBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConvictionCell, QUOTE_STALE_MS } from '@/components/ui/conviction';
import { Sparkline } from '@/components/dashboard/Sparkline';
import { cn, formatCompact, formatPremium, formatRatio, formatTime } from '@/lib/utils';
import type { TrackRecord } from '@/lib/learning-data';
import { useFlowStore } from '@/store/flowStore';
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
  trackRecord: TrackRecord | null;
}

interface SectionDef {
  id: string;
  label: string;
}

/** Which sections this ticker has, in reading order (cards with nothing to show are skipped). */
function sectionsFor(data: DetailResponse | undefined): SectionDef[] {
  const out: SectionDef[] = [{ id: 'overview', label: 'Overview' }];
  if (!data) return out;
  const { flow } = data;
  if (flow.analytics || flow.iv30 !== null) out.push({ id: 'volatility', label: 'Volatility & positioning' });
  out.push({ id: 'relative', label: 'Sector-relative' });
  if (data.trackRecord) out.push({ id: 'track-record', label: 'Track record' });
  if (flow.eventGauge) out.push({ id: 'event', label: 'Event move' });
  if (flow.idiosyncraticMoves && flow.idiosyncraticMoves.length > 0) out.push({ id: 'idiosyncratic', label: 'Idiosyncratic' });
  out.push({ id: 'history', label: 'History' });
  return out;
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
  // The streamed row (socket) is fresher than the 15s detail poll — prefer it for the header.
  const liveRow = useFlowStore((s) => s.rows[symbol]);
  const headerFlow = liveRow ?? query.data?.flow ?? null;
  const sections = sectionsFor(query.data);

  return (
    <div>
      <TickerHeader symbol={symbol} flow={headerFlow} sections={query.data ? sections : []} />
      <div className="mx-auto max-w-7xl px-4 pb-8 pt-4 lg:px-6">
        {query.isLoading ? (
          <div className="grid gap-3 xl:grid-cols-12">
            <Skeleton className="h-40 w-full xl:col-span-7" />
            <Skeleton className="h-40 w-full xl:col-span-5" />
            <Skeleton className="h-64 w-full xl:col-span-7" />
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
    </div>
  );
}

function HeaderStat({ label, children, title }: { label: string; children: ReactNode; title?: string }): JSX.Element {
  return (
    <div title={title}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <div className="mt-0.5 flex h-5 items-center gap-1.5 text-sm">{children}</div>
    </div>
  );
}

/**
 * Highlights the section nav entry for whichever section is at the top of the
 * view — or the last one once the page is scrolled to the bottom, where short
 * trailing sections can never reach the top.
 */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(',');
  useEffect(() => {
    const els = key
      .split(',')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const scroller = document.querySelector('main');
    const atBottom = (): boolean => !!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const visible = new Map<string, boolean>();
    const pick = (): void => {
      if (atBottom()) {
        setActive(els[els.length - 1]!.id);
        return;
      }
      const first = els.find((el) => visible.get(el.id));
      if (first) setActive(first.id);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        pick();
      },
      { rootMargin: '-160px 0px -55% 0px' },
    );
    els.forEach((el) => io.observe(el));
    scroller?.addEventListener('scroll', pick, { passive: true });
    return () => {
      io.disconnect();
      scroller?.removeEventListener('scroll', pick);
    };
  }, [key]);
  return active;
}

/**
 * Sticky page header: where you are (Scanner › sector › symbol), the live
 * price and the numbers you came for (learned lean, P/C, unusual activity,
 * IV), pin-to-scanner, and a jump bar for the sections below.
 */
function TickerHeader({ symbol, flow, sections }: { symbol: string; flow: TickerFlow | null; sections: SectionDef[] }): JSX.Element {
  const router = useRouter();
  const pinned = useFlowStore((s) => s.pinned.includes(symbol));
  const togglePin = useFlowStore((s) => s.togglePin);
  const setSectorFilter = useFlowStore((s) => s.setSectorFilter);
  const active = useActiveSection(sections.map((s) => s.id));

  const live = flow?.livePrice ?? null;
  const liveStale = flow?.livePriceAt != null && Date.now() - flow.livePriceAt > QUOTE_STALE_MS;
  const price = live ?? (flow && flow.underlyingPrice > 0 ? flow.underlyingPrice : null);
  const chg = live !== null ? flow?.livePriceChangePct ?? null : flow && flow.lastUpdated > 0 ? flow.priceChangePct : null;

  return (
    <div className="sticky top-0 z-20 border-b border-surface-border bg-surface/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 pt-3 lg:px-6">
        <nav className="flex items-center gap-1.5 text-[11px] text-slate-500" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-slate-300">
            Scanner
          </Link>
          {flow?.sector && flow.sector !== 'Unknown' && (
            <>
              <span aria-hidden>›</span>
              <button
                onClick={() => {
                  setSectorFilter(flow.sector);
                  router.push('/');
                }}
                className="hover:text-slate-300"
                title={`Show ${flow.sector} in the scanner`}
              >
                {flow.sector}
              </button>
            </>
          )}
          <span aria-hidden>›</span>
          <span className="text-slate-300">{symbol}</span>
        </nav>

        <div className="mt-1.5 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">{symbol}</h1>
            {flow?.inverse && (
              <span
                className="self-center rounded border border-caution/50 bg-caution/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-caution"
                title={`Inverse${flow.leverage !== 1 ? ` ${flow.leverage}×` : ''} product — sentiment is read in underlying-exposure terms (raw data untouched)`}
              >
                Inverse {flow.leverage !== 1 ? `${flow.leverage}×` : ''}
              </span>
            )}
            {flow && !flow.inverse && flow.leverage !== 1 && (
              <span className="self-center rounded border border-surface-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {flow.leverage}× leveraged
              </span>
            )}
            {price !== null ? (
              <span
                className={cn('text-lg font-semibold tnum', liveStale ? 'text-slate-400' : 'text-slate-100')}
                title={live !== null ? (liveStale ? 'Live quote (stale)' : 'Live last trade') : 'Delayed option-chain price — no live quote'}
              >
                {price.toFixed(2)}
                {chg !== null && (
                  <span className={cn('ml-2 text-sm', chg >= 0 ? 'text-bullish' : 'text-bearish', liveStale && 'opacity-70')}>
                    {chg >= 0 ? '+' : ''}
                    {chg.toFixed(2)}%
                  </span>
                )}
                {live === null && <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-slate-500">delayed</span>}
              </span>
            ) : (
              <span className="text-lg text-slate-600">—</span>
            )}
          </div>

          {flow && (
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <HeaderStat label="Learned lean" title="Signals from the latest session, weighted by how well each has actually worked — see Track record">
                <a href="#track-record" className="hover:opacity-80">
                  <ConvictionCell row={flow} />
                </a>
              </HeaderStat>
              <HeaderStat label="P/C 5m">
                <span className={cn('font-semibold tnum', flow.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')}>
                  {formatRatio(flow.putCallRatio)}
                </span>
              </HeaderStat>
              <HeaderStat label="Unusual" title={`Volume ${flow.volumeVsExpected.toFixed(1)}× expected`}>
                <SpikeBadge level={flow.spikeLevel} />
                <span className="tnum text-slate-300">{flow.spikeScore}</span>
              </HeaderStat>
              <HeaderStat label="IV30 · rank">
                <span className="tnum text-slate-200">{flow.iv30 !== null ? flow.iv30.toFixed(1) : '—'}</span>
                <span className={cn('tnum', (flow.ivRank ?? 0) >= 75 ? 'text-caution' : 'text-slate-500')}>
                  {flow.ivRank !== null ? `· ${flow.ivRank}` : ''}
                </span>
              </HeaderStat>
              <HeaderStat label="Updated">
                <span className="tnum text-slate-400">{flow.lastUpdated > 0 ? `${formatTime(flow.lastUpdated)} ET` : '—'}</span>
              </HeaderStat>
            </div>
          )}

          <button
            onClick={() => togglePin(symbol)}
            className={cn(
              'ml-auto flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs',
              pinned ? 'border-caution/50 text-caution' : 'border-surface-border text-slate-400 hover:text-slate-200',
            )}
            title={pinned ? 'Unpin from the top of the scanner' : 'Pin to the top of the scanner'}
          >
            {pinned ? '★ Pinned' : '☆ Pin to scanner'}
          </button>
        </div>

        <nav className="-mb-px mt-2 flex gap-5 overflow-x-auto text-xs" aria-label="Sections">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={cn(
                'whitespace-nowrap border-b-2 pb-2 pt-1',
                active === s.id ? 'border-blue-500 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300',
              )}
            >
              {s.label}
            </a>
          ))}
        </nav>
      </div>
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

const SIGNAL_NAMES: Record<string, string> = {
  skew_z: 'Skew z',
  divergence: 'Divergence',
  pc_extreme: 'OI P/C extreme',
  spike_alert: 'Volume spike',
};
const LEVEL_NAMES: Record<string, string> = {
  signal: 'This signal, all names',
  regime: '… in this market regime',
  sector: '… in this sector',
  ticker: '… on this stock',
};

const pts = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

/**
 * The stock's memory. Top: how today's learned edge was built, level by level —
 * each row shows what that level's own data says (raw) and how much it was
 * allowed to move the estimate (evidence). Then the name's own graded record and
 * its recent signals. Raw per-stock hit rates are shown honestly as raw: they
 * are small samples, which is exactly why the learned edge leans on the levels
 * above.
 */
function TrackRecordCard({ flow, record }: { flow: TickerFlow; record: TrackRecord | null }): JSX.Element | null {
  if (!record) return null;
  const c = flow.conviction;
  return (
    <Card>
      <CardHeader title={`Track record — what the app has learned (${record.horizon}-session excess vs SPY)`} />
      <div className="space-y-4 px-4 pb-4 pt-3">
        {record.note && <p className="text-[11px] text-slate-500">{record.note}</p>}

        {record.learned.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
              Learned edge for this session&apos;s signals ({record.learned[0]!.asOf})
              {c?.direction && (
                <span className={cn('ml-2 normal-case', c.direction === 'bullish' ? 'text-bullish' : 'text-bearish')}>
                  net {c.direction} {pts(c.score)} pts
                </span>
              )}
            </p>
            <div className="space-y-3">
              {record.learned.map((l) => (
                <div key={`${l.signalType}|${l.direction}`}>
                  <p className="text-[11px] text-slate-300">
                    {SIGNAL_NAMES[l.signalType] ?? l.signalType}{' '}
                    <span className={l.direction === 'bullish' ? 'text-bullish' : 'text-bearish'}>{l.direction}</span>
                    <span className="ml-2 tnum font-semibold text-slate-100">{pts(l.edge)} pts above base</span>
                  </p>
                  <table className="mt-1 w-full text-[11px] tnum">
                    <thead className="text-left text-[9px] uppercase tracking-wider text-slate-600">
                      <tr>
                        <th className="py-0.5 font-normal">Level</th>
                        <th className="py-0.5 text-right font-normal">Graded</th>
                        <th className="py-0.5 text-right font-normal" title="What this level's own data says, unshrunk">
                          Own data
                        </th>
                        <th className="py-0.5 text-right font-normal" title="Share of the estimate this level's evidence earned">
                          Weight
                        </th>
                        <th className="py-0.5 text-right font-normal">Estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.path.map((p) => (
                        <tr key={p.level} className="text-slate-400">
                          <td className="py-0.5">{LEVEL_NAMES[p.level] ?? p.level}</td>
                          <td className="py-0.5 text-right">{p.n}</td>
                          <td className="py-0.5 text-right">{p.raw === null ? '—' : pts(p.raw)}</td>
                          <td className="py-0.5 text-right">
                            <span
                              className="inline-block h-1.5 rounded-sm bg-slate-400/60 align-middle"
                              style={{ width: `${Math.round(p.evidence * 40)}px` }}
                            />{' '}
                            {Math.round(p.evidence * 100)}%
                          </td>
                          <td className="py-0.5 text-right text-slate-200">{pts(p.edge)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
              Each level starts from the one above and moves only as far as its own evidence earns. Low weight means
              &ldquo;not enough history here yet&rdquo; — the estimate leans on the broader record instead of a small sample.
            </p>
          </div>
        )}

        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">This stock&apos;s own record (raw)</p>
          {record.bySignal.length === 0 ? (
            <p className="text-[11px] text-slate-500">No graded signals yet — grading needs {record.horizon}+ sessions after a signal fires.</p>
          ) : (
            <div className="space-y-0.5">
              {record.bySignal.map((b) => (
                <div key={`${b.signalType}|${b.direction}`} className="flex gap-3 text-[11px] tnum text-slate-300">
                  <span className="w-40">
                    {SIGNAL_NAMES[b.signalType] ?? b.signalType}{' '}
                    <span className={b.direction === 'bullish' ? 'text-bullish' : 'text-bearish'}>{b.direction}</span>
                  </span>
                  <span className="w-24 text-right">
                    {b.hits}/{b.graded} hit
                  </span>
                  <span className="w-16 text-right">{b.hitRate === null ? '—' : `${Math.round(b.hitRate * 100)}%`}</span>
                  <span className="text-slate-500">avg {b.avgRet === null ? '—' : `${pts(b.avgRet)}%`}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {record.recent.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Recent signals</p>
            <div className="max-h-48 space-y-0.5 overflow-auto">
              {record.recent.map((r) => (
                <div key={`${r.firedOn}|${r.signalType}`} className="flex gap-3 text-[11px] tnum">
                  <span className="w-24 text-slate-400">{r.firedOn}</span>
                  <span className="w-40 text-slate-300">
                    {SIGNAL_NAMES[r.signalType] ?? r.signalType}{' '}
                    <span className={r.direction === 'bullish' ? 'text-bullish' : 'text-bearish'}>{r.direction}</span>
                  </span>
                  <span className="w-16 text-right">
                    {r.pending ? (
                      <span className="text-slate-600">pending</span>
                    ) : r.hit === null ? (
                      <span className="text-slate-600">no grade</span>
                    ) : r.hit ? (
                      <span className="text-bullish">hit</span>
                    ) : (
                      <span className="text-bearish">miss</span>
                    )}
                  </span>
                  <span className="text-slate-500">
                    {r.ret === null ? '' : `${pts(r.ret)}%`}
                    {r.terminalOn && <span className="ml-1 text-caution" title="Stopped trading inside the window — graded to its last close">· terminal {r.terminalOn}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} className="scroll-mt-40">
      {children}
    </section>
  );
}

/**
 * Two columns on wide screens: the live read on the left (overview, vol &
 * positioning, sector-relative), what the app has learned and event context on
 * the right; stored history full-width underneath. One column below xl.
 */
function TickerBody({ data }: { data: DetailResponse }): JSX.Element {
  const { flow, history } = data;
  return (
    <div className="grid items-start gap-3 xl:grid-cols-12">
      <div className="space-y-3 xl:col-span-7">
        <Section id="overview">
          <Card>
            <CardHeader title="Flow overview" />
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
                label="Chain price (delayed)"
                value={flow.underlyingPrice > 0 ? `$${flow.underlyingPrice.toFixed(2)}` : '—'}
                className={flow.priceChangePct >= 0 ? 'text-bullish' : 'text-bearish'}
              />
              <Stat label="Vol vs expected" value={`${flow.volumeVsExpected.toFixed(1)}×`} />
              <Stat label="Net flow 5m" value={`${flow.netFlow > 0 ? '+' : ''}${formatCompact(flow.netFlow)}`} className={flow.netFlow > 0 ? 'text-bullish' : flow.netFlow < 0 ? 'text-bearish' : undefined} />
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">P/C — last 30 min</p>
                <div className="mt-1">
                  <Sparkline points={flow.ratioSparkline} />
                </div>
              </div>
            </div>
          </Card>
        </Section>
        {(flow.analytics || flow.iv30 !== null) && (
          <Section id="volatility">
            <VolatilityCard flow={flow} />
          </Section>
        )}
        <Section id="relative">
          <SectorRelativeCard flow={flow} />
        </Section>
      </div>

      <div className="space-y-3 xl:col-span-5">
        {data.trackRecord && (
          <Section id="track-record">
            <TrackRecordCard flow={flow} record={data.trackRecord} />
          </Section>
        )}
        {flow.eventGauge && (
          <Section id="event">
            <EventGaugeCard flow={flow} />
          </Section>
        )}
        {flow.idiosyncraticMoves && flow.idiosyncraticMoves.length > 0 && (
          <Section id="idiosyncratic">
            <IdiosyncraticCard flow={flow} />
          </Section>
        )}
      </div>

      <div className="xl:col-span-12">
        <Section id="history">
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
        </Section>
      </div>
    </div>
  );
}
