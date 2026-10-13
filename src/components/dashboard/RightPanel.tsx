'use client';

/**
 * Scanner side panel: tabbed Market / Alerts / Regime / Leaders / Accuracy.
 * The chosen tab is remembered per browser.
 */
import { cn } from '@/lib/utils';
import { useAlerts } from '@/hooks/useAlerts';
import { usePersistentState } from '@/hooks/usePersistentState';
import { AccuracyPanel } from './AccuracyPanel';
import { AlertFeed } from './AlertFeed';
import { LeadersPanel } from './LeadersPanel';
import { MarketPanel } from './MarketPanel';
import { RegimePanel } from './RegimePanel';

const TABS = ['market', 'alerts', 'regime', 'leaders', 'accuracy'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: unknown): v is Tab => typeof v === 'string' && (TABS as readonly string[]).includes(v);

export function RightPanel(): JSX.Element {
  const [tab, setTab] = usePersistentState<Tab>('flow-ui-side-tab', 'market', isTab);
  const { alerts, unread, markRead } = useAlerts();

  const labels: Record<Tab, string> = {
    market: 'Market',
    alerts: 'Alerts',
    regime: 'Regime',
    leaders: 'Leaders',
    accuracy: 'Accuracy',
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-surface-border bg-surface-raised">
      <div className="flex shrink-0 border-b border-surface-border" role="tablist" aria-label="Side panel">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              if (t === 'alerts') markRead();
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1 border-b-2 px-1 py-2 text-[11px] font-medium',
              tab === t ? 'border-blue-500 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300',
            )}
          >
            {labels[t]}
            {t === 'alerts' && alerts.length > 0 && (
              <span
                className={cn(
                  'rounded-full px-1 text-[9px] tnum',
                  unread > 0 ? 'bg-bearish/80 text-white' : 'bg-surface-overlay text-slate-400',
                )}
              >
                {unread > 0 ? unread : alerts.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        {tab === 'market' && <MarketPanel />}
        {tab === 'alerts' && <AlertFeed embedded />}
        {tab === 'regime' && <RegimePanel />}
        {tab === 'leaders' && <LeadersPanel />}
        {tab === 'accuracy' && <AccuracyPanel />}
      </div>
    </div>
  );
}
