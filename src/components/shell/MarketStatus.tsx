'use client';

/**
 * The "can I trust this screen" pill in the top bar: data freshness (green
 * live / amber stale / red dead), market session, and which feed is driving
 * the numbers. Simulated data is always called out — it must never pass for
 * the real thing.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn, formatTime } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';

const SOURCE: Record<string, { label: string; title: string; warn: boolean }> = {
  simulator: { label: 'Simulated', title: 'Simulated data — not real market flow', warn: true },
  cboe: { label: 'Delayed 15m', title: 'CBOE free feed — option chains 15 minutes delayed', warn: false },
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

  const base = SOURCE[status.provider] ?? { label: status.provider, title: status.provider, warn: false };
  // Real-time overlay (Schwab): say how many names it covers right now.
  const rt = status.realtime;
  const source =
    rt && rt.state === 'polling' && rt.liveTickers > 0
      ? {
          label: `Real-time · ${rt.liveTickers}`,
          title: `Schwab real-time flow for ${rt.liveTickers} names; the rest, and all IV/OI analytics, ${base.title}`,
          warn: false,
        }
      : base;

  if (!status.marketOpen && status.mode !== 'simulated') {
    // Polling idles while the market is closed (by design): say how old the data is.
    const asOf = status.dataAsOf;
    return (
      <Link
        href="/connections"
        className="flex items-center gap-2 rounded-full border border-surface-border px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-500"
        title={`Market closed — polling resumes at the next open. ${source.title}`}
      >
        <span className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full bg-slate-500', status.catchUpRemaining > 0 && 'animate-pulse bg-caution')} />
          <span>Market closed</span>
        </span>
        <span className="h-3 w-px bg-surface-border" aria-hidden />
        <span className="tnum">
          {status.catchUpRemaining > 0
            ? `Loading the close · ${status.catchUpRemaining.toLocaleString()} left`
            : asOf > 0
              ? `Data as of ${dayTime(asOf)}`
              : 'No data yet'}
        </span>
        <span className="h-3 w-px bg-surface-border" aria-hidden />
        <span>{source.label}</span>
      </Link>
    );
  }

  if (status.lastPollAt === 0) {
    // Connected, but the first poll cycle has not finished (a cold start takes a minute or so).
    return (
      <Link
        href="/connections"
        className="flex items-center gap-1.5 rounded-full border border-surface-border px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-500"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
        Starting · first data loading
      </Link>
    );
  }

  const ageMs = now - status.lastPollAt;
  const freshness: 'live' | 'stale' | 'dead' = ageMs < 120_000 ? 'live' : ageMs < 300_000 ? 'stale' : 'dead';

  return (
    <Link
      href="/connections"
      className="flex items-center gap-2 rounded-full border border-surface-border px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-500"
      title={`Last poll ${formatTime(status.lastPollAt)} ET · ${source.title} · Data sources`}
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
      <span className={cn(source.warn && 'font-semibold uppercase tracking-wide text-caution', source !== base && 'text-bullish')}>
        {source.label}
      </span>
    </Link>
  );
}

/** "4:00 PM ET" for today, "Fri 4:00 PM ET" for an earlier day. */
function dayTime(ms: number): string {
  const et = (d: Date, o: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...o }).format(d);
  const d = new Date(ms);
  const time = et(d, { hour: 'numeric', minute: '2-digit' });
  const sameDay = et(d, { dateStyle: 'short' }) === et(new Date(), { dateStyle: 'short' });
  return sameDay ? `${time} ET` : `${et(d, { weekday: 'short' })} ${time} ET`;
}
