'use client';

/**
 * Spike alert feed + transient toasts for high-severity events. Alerts arrive
 * over the socket the moment the detector confirms a spike.
 */
import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { SpikeBadge } from '@/components/ui/badge';
import { cn, formatCompact, formatPremium, formatTime } from '@/lib/utils';
import { useAlerts } from '@/hooks/useAlerts';
import type { SpikeAlert } from '@/types';

export function AlertFeed(): JSX.Element {
  const { alerts } = useAlerts();

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title="Spike Alerts" right={<span className="text-[10px] text-slate-500 tnum">{alerts.length}</span>} />
      <div className="min-h-0 flex-1 overflow-auto">
        {alerts.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">No unusual activity detected yet.</p>
        ) : (
          <ul>
            {alerts.map((a) => (
              <li key={a.id} className="border-b border-surface-border/50 px-3 py-2 hover:bg-surface-overlay/40">
                <a href={`/ticker/${a.symbol}`} className="block">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100">{a.symbol}</span>
                    <SpikeBadge level={a.level} />
                    <span className="ml-auto text-[10px] text-slate-500 tnum">{formatTime(a.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{a.message}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500 tnum">
                    {formatCompact(a.contracts)} contracts · {formatPremium(a.premium)} premium
                  </p>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
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
        <a
          key={a.id}
          href={`/ticker/${a.symbol}`}
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
        </a>
      ))}
    </div>
  );
}
