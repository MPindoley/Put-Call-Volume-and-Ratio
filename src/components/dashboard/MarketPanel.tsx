'use client';

/**
 * Side-panel "Market" tab: the detail behind the market strip — intraday
 * aggregate ratio vs SPY, sector put/call ratios, the IV-dispersion proxy per
 * cohort, and a heatmap of the most active names' ratios.
 */
import Link from 'next/link';
import { useMemo } from 'react';
import { cn, formatCompact, formatRatio } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import { RatioChart } from './RatioChart';

/** Diverging color for a P/C ratio: bullish green → neutral slate → bearish red. */
function ratioColor(ratio: number): string {
  const t = Math.max(-1, Math.min(1, Math.log2(Math.max(ratio, 0.05)))); // ±1 at ratio 0.5 / 2.0
  if (Math.abs(t) < 0.08) return 'rgba(100,116,139,0.35)';
  return t < 0 ? `rgba(22,163,74,${0.15 + Math.abs(t) * 0.55})` : `rgba(239,68,68,${0.15 + Math.abs(t) * 0.55})`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b border-surface-border px-3 py-3 last:border-b-0">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500" title={hint}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function MarketPanel(): JSX.Element {
  const sectors = useFlowStore((s) => s.sectors);
  const dispersions = useFlowStore((s) => s.dispersions);
  const rows = useFlowStore((s) => s.rows);

  const heatmap = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.sessionPutVolume + r.sessionCallVolume > 0)
        .sort((a, b) => b.sessionPutVolume + b.sessionCallVolume - (a.sessionPutVolume + a.sessionCallVolume))
        .slice(0, 48),
    [rows],
  );
  const maxSectorRatio = Math.max(1.5, ...sectors.map((s) => s.ratio));
  const shownDispersions = dispersions.filter((d) => d.proxy !== null);

  return (
    <div>
      <Section title="Intraday P/C vs SPY">
        <RatioChart embedded />
      </Section>

      <Section title="Sector put/call" hint="Session put/call volume ratio by sector">
        {sectors.length === 0 ? (
          <p className="text-xs text-slate-500">Waiting for first flow data…</p>
        ) : (
          <ul className="space-y-1">
            {sectors.map((s) => (
              <li
                key={s.sector}
                className="flex items-center gap-2 text-[11px]"
                title={`${s.sector}: ${formatCompact(s.putVolume)} puts / ${formatCompact(s.callVolume)} calls across ${s.tickerCount} tickers`}
              >
                <span className="w-28 truncate text-slate-400">{s.sector}</span>
                <span className="relative h-2 flex-1 rounded-sm bg-surface-overlay">
                  <span
                    className={cn('absolute inset-y-0 left-0 rounded-sm', s.ratio > 1 ? 'bg-bearish/60' : 'bg-bullish/60')}
                    style={{ width: `${Math.min(100, (s.ratio / maxSectorRatio) * 100)}%` }}
                  />
                  <span
                    className="absolute inset-y-[-2px] w-px bg-slate-500"
                    style={{ left: `${(1 / maxSectorRatio) * 100}%` }}
                    aria-hidden
                    title="1.0 — neutral"
                  />
                </span>
                <span className={cn('w-10 text-right font-semibold tnum', s.ratio > 1 ? 'text-bearish' : 'text-bullish')}>
                  {formatRatio(s.ratio)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {shownDispersions.length > 0 && (
        <Section
          title="IV dispersion proxy"
          hint="Sector-ETF IV ÷ weighted-average constituent IV. High/rising = names moving together (macro regime); low/falling = dispersion (stock-picking). A proxy, not true implied correlation. Percentile vs the last 90 days."
        >
          <div className="grid grid-cols-3 gap-1.5">
            {shownDispersions.map((d) => (
              <Link
                key={d.cohort}
                href="/sectors"
                prefetch={false}
                className="rounded border border-surface-border px-2 py-1 text-[10px] text-slate-400 hover:border-slate-500"
                title={`${d.label}: proxy ${d.proxy} · ${d.weightMethod}-weighted · ${d.constituentCount} names · IQR ${d.medianIqr ?? '—'} · ${d.sampleDays} days`}
              >
                <span className="font-semibold text-slate-300">{d.cohort}</span>{' '}
                <span className="tnum text-slate-100">{(d.proxy as number).toFixed(2)}</span>
                {d.pct90 !== null ? (
                  <span className={cn('ml-1 tnum', d.pct90 >= 70 ? 'text-bearish' : d.pct90 <= 30 ? 'text-bullish' : 'text-slate-500')}>
                    {d.pct90}%
                  </span>
                ) : (
                  <span className="ml-1 text-slate-600" title="Percentile appears after 20 days of history">
                    {d.sampleDays}/20
                  </span>
                )}
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Most active — P/C heatmap" hint="Top names by session option volume, colored by put/call ratio">
        {heatmap.length === 0 ? (
          <p className="text-xs text-slate-500">Waiting for first flow data…</p>
        ) : (
          <div className="grid grid-cols-6 gap-1" aria-label="Per-ticker put/call ratio heatmap">
            {heatmap.map((r) => (
              <Link
                key={r.symbol}
                href={`/ticker/${r.symbol}`}
                prefetch={false}
                className="flex h-7 items-center justify-center rounded text-[9px] font-semibold text-slate-100 hover:ring-1 hover:ring-slate-400"
                style={{ backgroundColor: ratioColor(r.putCallRatio) }}
                title={`${r.symbol} — P/C ${formatRatio(r.putCallRatio)} · ${formatCompact(r.sessionPutVolume + r.sessionCallVolume)} contracts`}
              >
                {r.symbol}
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
