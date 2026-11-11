'use client';

/**
 * Drop-down sections: a page becomes a short list of titled bars, each showing
 * its headline whether open or closed, so the whole page reads at a glance and
 * the detail is one click away. Which sections are open is remembered per
 * browser (useSections), so the page opens the way it was left.
 */
import { createContext, useCallback, type ReactNode } from 'react';
import { usePersistentState } from '@/hooks/usePersistentState';
import type { GlossaryKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';
import { Term } from './term';

/** True directly inside an open section: cards there drop their own frame and title (card.tsx). */
export const EmbeddedContext = createContext(false);

/** Gives the cards inside it their own frames back — for a section that holds several cards side by side. */
export function Standalone({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <EmbeddedContext.Provider value={false}>
      <div className={className}>{children}</div>
    </EmbeddedContext.Provider>
  );
}

export function CollapsibleSection({
  id,
  title,
  summary,
  help,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  /** The section's headline, shown beside the title whether it is open or closed. Plain text. */
  summary?: ReactNode;
  /** Glossary entry explaining what the section is for and how to read it — shown from the "?" beside the title. */
  help?: GlossaryKey;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="scroll-mt-36 rounded-lg border border-surface-border bg-surface-raised">
      {/* The button covers the whole bar; the "?" sits above it, so the bar toggles and the "?" explains. */}
      <div
        className={cn(
          'relative flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3 py-2.5 hover:bg-surface-overlay/40',
          open ? 'rounded-t-lg' : 'rounded-lg',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          aria-labelledby={`${id}-title`}
          className={cn(
            'absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500',
            open ? 'rounded-t-lg' : 'rounded-lg',
          )}
        />
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={cn('h-3 w-3 shrink-0 text-slate-500 transition-transform', open && 'rotate-90')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        {/* A fixed title column, so the headlines line up down the page and read like a table. */}
        <div className="flex shrink-0 items-center gap-2 sm:w-60">
          <h2 id={`${id}-title`} className="text-xs font-semibold uppercase tracking-wider text-slate-200">
            {title}
          </h2>
          {help && (
            <span className="relative z-10 flex">
              <Term
                k={help}
                label={`About ${title}`}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-600 text-[10px] font-medium leading-none text-slate-400 no-underline hover:border-slate-400 hover:text-slate-200"
              >
                ?
              </Term>
            </span>
          )}
        </div>
        {summary && (
          <p className="min-w-0 basis-full pl-[22px] text-xs tnum text-slate-300 sm:basis-0 sm:flex-1 sm:truncate sm:pl-0">
            {summary}
          </p>
        )}
      </div>
      {open && (
        <div id={`${id}-body`} className="border-t border-surface-border">
          <EmbeddedContext.Provider value={true}>{children}</EmbeddedContext.Provider>
        </div>
      )}
    </section>
  );
}

const isOpenMap = (v: unknown): v is Record<string, boolean> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');

const NONE: readonly string[] = [];

export interface Sections {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Open a section and bring it into view. */
  reveal: (id: string) => void;
  setAll: (ids: readonly string[], open: boolean) => void;
}

/**
 * Open/closed state for a page's sections, remembered under `storageKey`.
 * Sections start closed unless listed in `defaultOpen` (pass a stable array).
 */
export function useSections(storageKey: string, defaultOpen: readonly string[] = NONE): Sections {
  const [map, setMap] = usePersistentState<Record<string, boolean>>(storageKey, {}, isOpenMap);
  const isOpen = useCallback((id: string): boolean => map[id] ?? defaultOpen.includes(id), [map, defaultOpen]);
  const toggle = useCallback(
    (id: string) => setMap((m) => ({ ...m, [id]: !(m[id] ?? defaultOpen.includes(id)) })),
    [setMap, defaultOpen],
  );
  const reveal = useCallback(
    (id: string) => {
      setMap((m) => (m[id] ? m : { ...m, [id]: true }));
      // Two frames: one for the section to open, one for its content to lay out.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })),
      );
    },
    [setMap],
  );
  const setAll = useCallback(
    (ids: readonly string[], open: boolean) => setMap((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, open])) })),
    [setMap],
  );
  return { isOpen, toggle, reveal, setAll };
}
