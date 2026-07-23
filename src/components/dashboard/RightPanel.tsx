'use client';

/** Right column: tabbed Alerts / Accuracy / Regime / Leaders. */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useAlerts } from '@/hooks/useAlerts';
import { AccuracyPanel } from './AccuracyPanel';
import { AlertFeed } from './AlertFeed';
import { LeadersPanel } from './LeadersPanel';
import { RegimePanel } from './RegimePanel';

type Tab = 'alerts' | 'accuracy' | 'regime' | 'leaders';

export function RightPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('alerts');
  const { alerts } = useAlerts();

  const tabs: { id: Tab; label: string }[] = [
    { id: 'alerts', label: `Alerts${alerts.length > 0 ? ` (${alerts.length})` : ''}` },
    { id: 'accuracy', label: 'Accuracy' },
    { id: 'regime', label: 'Regime' },
    { id: 'leaders', label: 'Leaders' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-surface-border bg-surface-raised">
      <div className="flex border-b border-surface-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 px-2 py-2 text-[11px] font-semibold uppercase tracking-wider',
              tab === t.id
                ? 'border-b-2 border-blue-500 text-slate-100'
                : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'alerts' && <AlertFeed embedded />}
        {tab === 'accuracy' && <AccuracyPanel />}
        {tab === 'regime' && <RegimePanel />}
        {tab === 'leaders' && <LeadersPanel />}
      </div>
    </div>
  );
}
