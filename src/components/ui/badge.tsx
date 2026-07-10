import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { SpikeLevel } from '@/types';

const LEVEL_STYLES: Record<SpikeLevel, string> = {
  normal: 'bg-surface-overlay text-slate-400 border-surface-border',
  elevated: 'bg-caution/15 text-caution border-caution/40',
  significant: 'bg-severe/15 text-severe border-severe/40',
  extreme: 'bg-bearish/15 text-bearish border-bearish/40',
};

const LEVEL_LABELS: Record<SpikeLevel, string> = {
  normal: 'Normal',
  elevated: 'Elevated',
  significant: 'Significant',
  extreme: 'Extreme',
};

export function SpikeBadge({ level }: { level: SpikeLevel }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        LEVEL_STYLES[level],
      )}
    >
      {LEVEL_LABELS[level]}
    </span>
  );
}

export function Badge({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border border-surface-border bg-surface-overlay px-1.5 py-0.5 text-[10px] font-medium text-slate-300',
        className,
      )}
    >
      {children}
    </span>
  );
}
