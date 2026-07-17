'use client';

/**
 * Top status strip: data freshness (green/yellow/red), source mode, market
 * hours, API budget, DB state, socket state. The freshness dot is the
 * at-a-glance "can I trust this screen" indicator.
 */
import { useEffect, useState } from 'react';
import { useFlowStore } from '@/store/flowStore';
import { formatTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

export function StatusBar(): JSX.Element {
  const status = useFlowStore((s) => s.status);
  const socketConnected = useFlowStore((s) => s.socketConnected);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const ageMs = status ? now - status.lastPollAt : Infinity;
  const freshness: 'live' | 'stale' | 'dead' =
    ageMs < 120_000 ? 'live' : ageMs < 300_000 ? 'stale' : 'dead';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-surface-border bg-surface-raised px-4 py-2 text-xs text-slate-400">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            freshness === 'live' && 'bg-bullish',
            freshness === 'stale' && 'bg-caution',
            freshness === 'dead' && 'bg-bearish',
          )}
        />
        {status
          ? freshness === 'live'
            ? `Data live · updated ${formatTime(status.lastPollAt)} ET`
            : `Data stale — last update ${formatTime(status.lastPollAt)} ET`
          : 'Connecting…'}
      </span>
      {status && (
        <>
          <span className={cn(status.mode === 'simulated' && 'text-caution')}>
            {status.provider === 'simulator'
              ? 'SIMULATED DATA'
              : status.provider === 'cboe'
                ? 'CBOE free feed (15-min delayed)'
                : 'Massive live'}
          </span>
          <span>{status.marketOpen ? 'Market open' : 'Market closed'}</span>
          {status.rateLimitPerMinute > 0 && (
            <span className="tnum">
              API {status.apiCallsLastMinute}/{status.rateLimitPerMinute} per min
            </span>
          )}
          <span>{status.tickersTracked} tickers</span>
          <span className={cn(!status.dbConnected && 'text-caution')}>
            {status.dbConnected ? 'DB connected' : 'DB off — live only'}
          </span>
        </>
      )}
      <span className={cn('ml-auto', socketConnected ? 'text-bullish' : 'text-caution')}>
        {socketConnected ? '⦿ WebSocket' : '⟳ HTTP polling fallback'}
      </span>
      <a href="/api/export" className="rounded border border-surface-border px-2 py-0.5 hover:bg-surface-overlay">
        Export CSV
      </a>
    </div>
  );
}
