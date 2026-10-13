'use client';

/**
 * Scanner page. Table-first: a one-row market strip, then the scan table
 * filling the rest of the screen beside a collapsible side panel (Market /
 * Alerts / Regime / Leaders / Accuracy). Socket, snapshot, toasts and
 * shortcuts are owned by the app shell. Each region sits in an error
 * boundary so one failing panel never takes down the screen.
 */
import { PanelBoundary } from '@/components/ui/panel-boundary';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import { FlowTable } from './FlowTable';
import { MarketStrip } from './MarketStrip';
import { RightPanel } from './RightPanel';

export function Dashboard(): JSX.Element {
  const isLoading = useFlowStore((s) => s.status === null);
  const [panelOpen, setPanelOpen] = usePersistentState('flow-ui-side-panel-open', true);

  return (
    <div className="flex flex-col gap-3 p-3 xl:h-full">
      <PanelBoundary name="market summary">
        <MarketStrip />
      </PanelBoundary>

      <div className={cn('grid grid-cols-1 gap-3 xl:min-h-0 xl:flex-1', panelOpen && 'xl:grid-cols-[minmax(0,1fr)_340px]')}>
        <div className="h-[75vh] min-h-[420px] min-w-0 xl:h-auto xl:min-h-0">
          <PanelBoundary name="flow table">
            <FlowTable isLoading={isLoading} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
          </PanelBoundary>
        </div>
        {panelOpen && (
          <div className="h-[640px] min-w-0 xl:h-auto xl:min-h-0">
            <PanelBoundary name="side">
              <RightPanel />
            </PanelBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
