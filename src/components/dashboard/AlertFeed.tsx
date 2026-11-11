'use client';

/**
 * Spike alert feed + transient toasts for high-severity events. Alerts arrive
 * over the socket the moment the detector confirms a spike.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { SpikeBadge } from '@/components/ui/badge';
import { cn, formatCompact, formatPremium, formatTime } from '@/lib/utils';
import { useAlerts } from '@/hooks/useAlerts';
import type { SpikeAlert, SpikeFollowThrough } from '@/types';

export function AlertFeed({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const { alerts } = useAlerts();

  const body =
    alerts.length === 0 ? (
      <p className="py-8 text-center text-xs text-slate-500">No unusual activity detected yet.</p>
    ) : (
      <ul>
        {alerts.map((a) => (
          <li key={a.id} className="border-b border-surface-border/50 px-3 py-2 hover:bg-surface-overlay/40">
            <Link href={`/ticker/${a.symbol}`} prefetch={false} className="block">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-100">{a.symbol}</span>
                <SpikeBadge level={a.level} />
                <span className="ml-auto text-[10px] text-slate-500 tnum">{formatTime(a.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-400">{a.message}</p>
              <p className="mt-0.5 text-[10px] text-slate-500 tnum">
                {formatCompact(a.contracts)} contracts · {formatPremium(a.premium)} premium
              </p>
              {a.breadth && (
                <p
                  className="mt-0.5 text-[10px] text-slate-400 tnum"
                  title="How many names in its sector were spiking when this alert fired"
                >
                  {a.breadth.crowd ? 'Sector-wide' : 'One name'}: {a.breadth.spiking} of {a.breadth.names} {a.breadth.sector}{' '}
                  names spiking
                  {a.breadth.spiking > 1 && ` (${a.breadth.sameLean} leaning the same way)`}
                </p>
              )}
              {a.followThrough && <FollowThroughLine symbol={a.symbol} f={a.followThrough} />}
            </Link>
          </li>
        ))}
      </ul>
    );

  if (embedded) return body;

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title="Spike Alerts" right={<span className="text-[10px] text-slate-500 tnum">{alerts.length}</span>} />
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </Card>
  );
}

/** What followed past spikes like this one (spike-outcomes.ts): the learned follow-through, and whose record it is. */
function FollowThroughLine({ symbol, f }: { symbol: string; f: SpikeFollowThrough }): JSX.Element {
  const who = f.level === 'ticker' ? `${symbol}'s` : f.level === 'sector' ? "its sector's" : 'all';
  const windows = [
    f.m30 !== null && `30 min ${Math.round(f.m30 * 100)}%`,
    f.close !== null && `by the close ${Math.round(f.close * 100)}%`,
    f.next !== null && `next day ${Math.round(f.next * 100)}%`,
  ].filter(Boolean);
  return (
    <p
      className="mt-0.5 text-[10px] text-slate-400 tnum"
      title="How often the price kept moving the way past spikes like this leaned, from the moment the alert appeared (single names: against SPY). 50% is a coin flip."
    >
      Learned from {who} {f.n} past {f.part} {f.lean === 'calls' ? 'call' : 'put'}-heavy spikes — kept going:{' '}
      {windows.join(' · ')}
    </p>
  );
}

/** Toasts for significant/extreme alerts; auto-dismiss after 6s. */
export function AlertToasts(): JSX.Element {
  const { alerts } = useAlerts();
  const [visible, setVisible] = useState<SpikeAlert[]>([]);

  useEffect(() => {
    const newest = alerts[0];
    if (!newest || newest.level === 'elevated') return;
    if (Date.now() - newest.createdAt > 10_000) return; // history, not live
    setVisible((v) => (v.some((t) => t.id === newest.id) ? v : [newest, ...v].slice(0, 4)));
    const timer = setTimeout(() => setVisible((v) => v.filter((t) => t.id !== newest.id)), 6_000);
    return () => clearTimeout(timer);
  }, [alerts]);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
      {visible.map((a) => (
        <Link
          key={a.id}
          href={`/ticker/${a.symbol}`}
          prefetch={false}
          className={cn(
            'pointer-events-auto w-72 rounded-lg border bg-surface-raised p-3 shadow-xl',
            a.level === 'extreme' ? 'border-bearish/60' : 'border-severe/60',
          )}
        >
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-100">{a.symbol}</span>
            <SpikeBadge level={a.level} />
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{a.message}</p>
        </Link>
      ))}
    </div>
  );
}
