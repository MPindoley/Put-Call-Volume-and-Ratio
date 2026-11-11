'use client';

/**
 * Spike alert feed + transient toasts for high-severity events. Alerts arrive
 * over the socket the moment the detector confirms a spike.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { SpikeBadge } from '@/components/ui/badge';
import { Term } from '@/components/ui/term';
import { useFlowStore } from '@/store/flowStore';
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
          <AlertRow key={a.id} a={a} />
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

/** The one learned figure worth a glance: how often spikes like this kept going, at the nearest window that has an answer. */
function keptGoing(f: SpikeFollowThrough): string | null {
  const [rate, when] = f.m30 !== null ? [f.m30, 'in 30 min'] : f.close !== null ? [f.close, 'by the close'] : f.next !== null ? [f.next, 'next day'] : [null, ''];
  return rate === null ? null : `kept going ${Math.round(rate * 100)}% ${when}`;
}

/**
 * One alert in two lines — who, how big, which way, when; then whether it is
 * one name or its sector and what spikes like it have done. Clicking it opens
 * that stock's quick look; the arrow shows the rest.
 */
function AlertRow({ a }: { a: SpikeAlert }): JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = useFlowStore((s) => s.selected === a.symbol);
  const setSelected = useFlowStore((s) => s.setSelected);
  const putHeavy = a.putCallRatio > 1;
  const second = [
    a.breadth ? (a.breadth.crowd ? `Sector-wide (${a.breadth.spiking} of ${a.breadth.names})` : 'One name') : null,
    a.followThrough ? keptGoing(a.followThrough) : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className={cn('border-b border-surface-border/50', selected && 'bg-blue-500/10 shadow-[inset_2px_0_0_0_#3b82f6]')}>
      {/* The button covers both lines; only the details arrow sits above it. */}
      <div className="relative hover:bg-surface-overlay/40">
        <button
          type="button"
          onClick={() => setSelected(a.symbol)}
          aria-label={`Quick look: ${a.symbol}`}
          title={`Quick look at ${a.symbol}`}
          className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500"
        />
        <div className="flex items-center gap-2 px-3 pt-2">
          <span className="text-[13px] font-semibold text-slate-100">{a.symbol}</span>
          <SpikeBadge level={a.level} />
          <span className="text-[11px] tnum text-slate-300">
            {a.volumeMultiple.toFixed(1)}× · <span className={putHeavy ? 'text-bearish' : 'text-bullish'}>{putHeavy ? 'put-heavy' : 'call-heavy'}</span>
          </span>
          <span className="ml-auto text-[10px] tnum text-slate-500">{formatTime(a.createdAt).slice(0, 5)}</span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details of the ${a.symbol} alert`}
            title={open ? 'Hide details' : 'Show details'}
            className="relative z-10 -mr-1 rounded p-1 text-slate-500 hover:bg-surface-overlay hover:text-slate-200"
          >
            <svg viewBox="0 0 12 12" aria-hidden className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 2l4 4-4 4" />
            </svg>
          </button>
        </div>
        <p className="truncate px-3 pb-2 text-[10px] tnum text-slate-500">{second.length > 0 ? second.join(' · ') : `P/C ${a.putCallRatio.toFixed(2)}`}</p>
      </div>
      {open && (
        <div className="space-y-0.5 px-3 pb-2">
          <p className="text-[11px] text-slate-400">{a.message}</p>
          <p className="text-[10px] text-slate-500 tnum">
            {formatCompact(a.contracts)} contracts · {formatPremium(a.premium)} premium · {formatTime(a.createdAt)} ET
          </p>
          {a.breadth && (
            <p className="text-[10px] text-slate-400 tnum">
              <Term k="spikeBreadth">{a.breadth.crowd ? 'Sector-wide' : 'One name'}</Term>: {a.breadth.spiking} of {a.breadth.names} {a.breadth.sector}{' '}
              names spiking
              {a.breadth.spiking > 1 && ` (${a.breadth.sameLean} leaning the same way)`}
            </p>
          )}
          {a.followThrough && <FollowThroughLine symbol={a.symbol} f={a.followThrough} />}
          <Link href={`/ticker/${a.symbol}`} prefetch={false} className="inline-block pt-0.5 text-[11px] text-blue-400 hover:underline">
            Open {a.symbol}&apos;s page →
          </Link>
        </div>
      )}
    </li>
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
    <p className="text-[10px] text-slate-400 tnum">
      Learned from {who} {f.n} past {f.part} {f.lean === 'calls' ? 'call' : 'put'}-heavy spikes — <Term k="followThrough">kept going</Term>:{' '}
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
