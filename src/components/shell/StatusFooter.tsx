'use client';

/**
 * Slim status line along the bottom of every page: plumbing that matters when
 * something looks wrong (stream vs polling fallback, API budget, DB) but that
 * should not compete with the data for attention.
 */
import { cn } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import { openShortcutHelp } from '@/components/dashboard/KeyboardShortcuts';

export function StatusFooter(): JSX.Element {
  const status = useFlowStore((s) => s.status);
  const socketConnected = useFlowStore((s) => s.socketConnected);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-surface-border bg-surface-raised px-4 text-[11px] text-slate-500">
      <span className={cn('flex items-center gap-1.5', socketConnected ? 'text-slate-400' : 'text-caution')}>
        <span className={cn('h-1.5 w-1.5 rounded-full', socketConnected ? 'bg-bullish' : 'bg-caution')} />
        {socketConnected ? 'Streaming' : 'Polling fallback (stream reconnecting)'}
      </span>
      {status && (
        <>
          {status.rateLimitPerMinute > 0 && (
            <span className="tnum" title="Data-provider API calls in the last minute vs the per-minute budget">
              API {status.apiCallsLastMinute}/{status.rateLimitPerMinute}/min
            </span>
          )}
          <span className="tnum">{status.tickersTracked} tickers</span>
          <span className={cn(!status.dbConnected && 'text-caution')} title={status.dbConnected ? undefined : 'No database — history, learning and grading are paused'}>
            {status.dbConnected ? 'Database connected' : 'Database offline — live only'}
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <button onClick={openShortcutHelp} className="hover:text-slate-300">
          <kbd className="rounded border border-surface-border px-1 text-[10px]">?</kbd> Shortcuts
        </button>
        <a href="/api/export" className="hover:text-slate-300" download>
          Export CSV
        </a>
      </span>
    </footer>
  );
}
