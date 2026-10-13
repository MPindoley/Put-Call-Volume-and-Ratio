'use client';

/**
 * The "can I trust this screen" pill in the top bar: data freshness (green
 * live / amber stale / red dead), market session, and which feed is driving
 * the numbers. Simulated data is always called out — it must never pass for
 * the real thing.
 */
import { useEffect, useState } from 'react';
import { cn, formatTime } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';

const SOURCE: Record<string, { label: string; title: string; warn: boolean }> = {
  simulator: { label: 'Simulated', title: 'Simulated data — not real market flow', warn: true },
  cboe: { label: 'Delayed 15m', title: 'CBOE free feed — option chains are 15 minutes delayed', warn: false },
  massive: { label: 'Real-time', title: 'Massive real-time feed', warn: false },
};

export function MarketStatus(): JSX.Element {
  const status = useFlowStore((s) => s.status);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  if (!status) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-surface-border px-2.5 py-1 text-[11px] text-slate-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-500" />
        Connecting…
      </span>
    );
  }

  const ageMs = now - status.lastPollAt;
  const freshness: 'live' | 'stale' | 'dead' = ageMs < 120_000 ? 'live' : ageMs < 300_000 ? 'stale' : 'dead';
  const source = SOURCE[status.provider] ?? { label: status.provider, title: status.provider, warn: false };

  return (
    <span
      className="flex items-center gap-2 rounded-full border border-surface-border px-2.5 py-1 text-[11px] text-slate-400"
      title={`Last poll ${formatTime(status.lastPollAt)} ET · ${source.title}`}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            freshness === 'live' && 'bg-bullish',
            freshness === 'stale' && 'bg-caution',
            freshness === 'dead' && 'bg-bearish',
          )}
        />
        <span className={cn('tnum', freshness !== 'live' && 'text-caution')}>
          {freshness === 'live' ? 'Live' : 'Stale'} · {formatTime(status.lastPollAt)} ET
        </span>
      </span>
      <span className="h-3 w-px bg-surface-border" aria-hidden />
      <span>{status.marketOpen ? 'Market open' : 'Market closed'}</span>
      <span className="h-3 w-px bg-surface-border" aria-hidden />
      <span className={cn(source.warn && 'font-semibold uppercase tracking-wide text-caution')}>{source.label}</span>
    </span>
  );
}
