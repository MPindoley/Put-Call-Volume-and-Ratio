'use client';

import { useState } from 'react';
import { useAlerts } from '@/hooks/useAlerts';
import { SpikeBadge } from '@/components/ui/badge';
import { formatTime } from '@/lib/utils';

export function NotificationBell(): JSX.Element {
  const { alerts, unread, markRead } = useAlerts();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markRead();
        }}
        className="relative rounded p-1.5 text-slate-400 hover:bg-surface-overlay hover:text-slate-200"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bearish px-1 text-[9px] font-bold text-white tnum">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 max-h-96 w-80 overflow-auto rounded-lg border border-surface-border bg-surface-raised shadow-xl">
          {alerts.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">No notifications.</p>
          ) : (
            alerts.slice(0, 30).map((a) => (
              <a key={a.id} href={`/ticker/${a.symbol}`} className="block border-b border-surface-border/50 px-3 py-2 hover:bg-surface-overlay/40">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-100">{a.symbol}</span>
                  <SpikeBadge level={a.level} />
                  <span className="ml-auto text-[10px] text-slate-500 tnum">{formatTime(a.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">{a.message}</p>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
