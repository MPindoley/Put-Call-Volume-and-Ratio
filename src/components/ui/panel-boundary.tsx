'use client';

/** Error boundary for one region of a page, so a failing panel never takes down the screen. */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
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
          The {this.props.name} panel hit an error — the rest of the page is unaffected.
        </div>
      );
    }
    return this.props.children;
  }
}
