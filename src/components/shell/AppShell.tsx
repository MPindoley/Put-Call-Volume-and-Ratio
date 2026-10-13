'use client';

/**
 * The frame around every page: top bar (brand, primary nav, ticker search,
 * data status, notifications, settings), the page, and a slim status footer.
 *
 * It also owns the app-wide plumbing that used to live only on the scanner —
 * the live socket, the flow snapshot, alert toasts and keyboard shortcuts — so
 * every page shows live status, toasts arrive wherever you are, and moving
 * between pages (client-side via next/link) keeps the stream connected instead
 * of reloading it.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AlertToasts } from '@/components/dashboard/AlertFeed';
import { KeyboardShortcuts } from '@/components/dashboard/KeyboardShortcuts';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';
import { PanelBoundary } from '@/components/ui/panel-boundary';
import { useOptionsFlow } from '@/hooks/useOptionsFlow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { MarketStatus } from './MarketStatus';
import { StatusFooter } from './StatusFooter';
import { TickerSearch } from './TickerSearch';

export const NAV: { href: string; label: string; hint: string }[] = [
  { href: '/', label: 'Scanner', hint: 'Live put/call flow across the tracked universe' },
  { href: '/sectors', label: 'Cohorts', hint: 'Peer-cohort health and IV dispersion' },
  { href: '/learning', label: 'Learning', hint: 'What the app has learned from its own signals' },
];

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  useWebSocket();
  const { isError } = useOptionsFlow();
  const pathname = usePathname();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-surface-border bg-surface-raised px-4">
        <Link href="/" className="flex items-center gap-2" aria-label="Options Flow — Scanner">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-blue-500/15 text-blue-400" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 17l5-6 4 4 8-10" />
            </svg>
          </span>
          <span className="hidden text-sm font-semibold tracking-tight text-slate-100 sm:inline">Options Flow</span>
        </Link>

        <nav className="flex h-full items-stretch" aria-label="Primary">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.hint}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center border-b-2 px-3 text-xs font-medium transition-colors',
                  active ? 'border-blue-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-1 justify-center px-2">
          <TickerSearch />
        </div>

        <div className="flex items-center gap-1">
          <div className="mr-2 hidden lg:block">
            <MarketStatus />
          </div>
          <NotificationBell />
          <SettingsPanel />
        </div>
      </header>

      {isError && (
        <p className="shrink-0 border-b border-bearish/40 bg-bearish/10 px-4 py-1.5 text-xs text-bearish">
          Backend unreachable — showing last known data. Retrying automatically.
        </p>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <PanelBoundary key={pathname} name="page">
          {children}
        </PanelBoundary>
      </main>

      <StatusFooter />
      <AlertToasts />
      <KeyboardShortcuts />
    </div>
  );
}
