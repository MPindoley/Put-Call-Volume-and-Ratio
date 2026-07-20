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
      <h1 className="mt-2 text-2xl font-bold text-slate-100">{symbol}</h1>

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
