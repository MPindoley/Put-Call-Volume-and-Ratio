'use client';

/**
 * "Answer first, detail on request": a section leads with its reading, and the
 * dense tables behind it sit under one of these. The choice is remembered per
 * browser, so someone who always wants the tables only asks once.
 */
import type { ReactNode } from 'react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';

/** Open/closed state of one kind of detail, remembered under `detail.<id>`. */
export function useDetail(id: string): [boolean, () => void] {
  const [open, setOpen] = usePersistentState<boolean>(`detail.${id}`, false);
  return [open, () => setOpen((v) => !v)];
}

/** The control alone, for a detail whose content is rendered elsewhere (several tables under one switch). */
export function DetailToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="inline-flex items-center gap-1.5 rounded text-left text-[11px] text-blue-400 hover:text-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
    >
      <svg
        viewBox="0 0 12 12"
        aria-hidden
        className={cn('h-2.5 w-2.5 shrink-0 transition-transform', open && 'rotate-90')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 2l4 4-4 4" />
      </svg>
      {open ? 'Hide' : 'Show'} {label}
    </button>
  );
}

export function MoreDetail({
  id,
  label,
  className,
  children,
}: {
  id: string;
  /** What is behind it, completing "Show …" / "Hide …". */
  label: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, toggle] = useDetail(id);
  return (
    <div className={className}>
      <DetailToggle open={open} onToggle={toggle} label={label} />
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
