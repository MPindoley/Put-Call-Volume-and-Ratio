import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={cn('rounded-lg border border-surface-border bg-surface-raised', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-surface-border px-3 py-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      {right}
    </div>
  );
}
