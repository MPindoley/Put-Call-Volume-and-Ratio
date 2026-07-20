'use client';

/**
 * Client dashboard composition: wires the socket + query hydration once and
 * lays out status bar, ratio panels, alert feed and the flow table.
 * Each region is wrapped in an error boundary so one failing panel never
 * takes down the screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useOptionsFlow } from '@/hooks/useOptionsFlow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { AlertToasts } from './AlertFeed';
import { BenchmarkStrip } from './BenchmarkStrip';
import { FlowTable } from './FlowTable';
import { NotificationBell } from './NotificationBell';
import { RatioChart } from './RatioChart';
import { RatioPanel } from './RatioPanel';
import { RightPanel } from './RightPanel';
import { SettingsPanel } from './SettingsPanel';
import { StatusBar } from './StatusBar';

class PanelBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[panel:${this.props.name}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center rounded-lg border border-bearish/40 bg-surface-raised p-4 text-xs text-slate-400">
          The {this.props.name} panel hit an error — the rest of the dashboard is unaffected.
        </div>
      );
    }
    return this.props.children;
  }
}

export function Dashboard(): JSX.Element {
  useWebSocket();
  const { isLoading, isError } = useOptionsFlow();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-surface-border bg-surface-raised px-4 py-2">
        <h1 className="text-sm font-bold tracking-tight text-slate-100">
          OPTIONS FLOW <span className="font-normal text-slate-500">· S&amp;P 500 put/call analytics</span>
        </h1>
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          <SettingsPanel />
        </div>
      </header>

      <PanelBoundary name="status">
        <StatusBar />
      </PanelBoundary>

      {isError && (
        <p className="border-b border-bearish/40 bg-bearish/10 px-4 py-1.5 text-xs text-bearish">
          Backend unreachable — showing last known data. Retrying automatically.
        </p>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-[1fr_360px]">
        <div className="flex min-h-0 flex-col gap-3">
          <PanelBoundary name="benchmarks">
            <BenchmarkStrip />
          </PanelBoundary>
          <div className="grid shrink-0 grid-cols-1 gap-3 lg:grid-cols-2">
            <PanelBoundary name="ratio">
              <RatioPanel />
            </PanelBoundary>
            <PanelBoundary name="chart">
              <RatioChart />
            </PanelBoundary>
          </div>
          <PanelBoundary name="flow table">
            <FlowTable isLoading={isLoading} />
          </PanelBoundary>
        </div>
        <div className="flex min-h-0 flex-col">
          <PanelBoundary name="alerts">
            <RightPanel />
          </PanelBoundary>
        </div>
      </main>

      <AlertToasts />
    </div>
  );
}
