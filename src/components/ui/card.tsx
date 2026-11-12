'use client';

import { useContext, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { EmbeddedContext } from './collapsible';

/**
 * A framed panel. Directly inside an open drop-down section (collapsible.tsx)
 * the section already draws the frame and the title, so the card drops its own.
 */
export function Card({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  const embedded = useContext(EmbeddedContext);
  return (
    <div className={cn(!embedded && 'rounded-lg border border-surface-border bg-surface-raised', className)}>{children}</div>
  );
}

export function CardHeader({ title, right }: { title: string; right?: ReactNode }): JSX.Element | null {
  const embedded = useContext(EmbeddedContext);
  if (embedded) {
    // The section header carries the title; keep only what sat beside it.
    return right ? <div className="flex items-center justify-end px-3 pt-2">{right}</div> : null;
  }
  return (
    <div className="flex items-center justify-between border-b border-surface-border px-3 py-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      {right}
    </div>
  );
}
