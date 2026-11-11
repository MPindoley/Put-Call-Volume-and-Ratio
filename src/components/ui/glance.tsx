'use client';

/**
 * The block at the top of a page that answers its question at a glance: a few
 * plain sentences, then a strip of tiles — answer first, the numbers behind it
 * second. A tile's label explains itself on hover; the rest of the tile opens
 * the section that holds the detail. Shared by the stock and Learning pages so
 * they read as one product.
 */
import type { ReactNode } from 'react';
import type { GlossaryKey } from '@/lib/glossary';
import type { Tone } from '@/lib/ticker-summary';
import { cn } from '@/lib/utils';
import { Term } from './term';

const TONE_CLASS: Record<Tone, string> = {
  bullish: 'text-bullish',
  bearish: 'text-bearish',
  caution: 'text-caution',
  neutral: 'text-slate-100',
  muted: 'text-slate-500',
};

/** Expects six tiles: two, three or six to a row leaves no empty cell. */
export function GlanceBlock({
  label,
  sentence,
  children,
}: {
  label: string;
  sentence?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section aria-label={label} className="overflow-hidden rounded-lg border border-surface-border bg-surface-raised">
      {sentence && <p className="border-b border-surface-border px-4 py-3 text-sm leading-relaxed text-slate-200">{sentence}</p>}
      {/* One-pixel gaps over the border colour draw the dividers between tiles at every column count. */}
      <div className="grid grid-cols-2 gap-px bg-surface-border md:grid-cols-3 xl:grid-cols-6">{children}</div>
    </section>
  );
}

export function GlanceTile({
  label,
  term,
  verdict,
  detail,
  tone,
  opens,
  onOpen,
}: {
  label: string;
  term: GlossaryKey;
  verdict: string;
  detail: string;
  tone: Tone;
  /** Title of the section this tile opens; null when there is nothing to open. */
  opens: string | null;
  onOpen?: () => void;
}): JSX.Element {
  const clickable = opens !== null && onOpen !== undefined;
  return (
    <div className={cn('relative bg-surface-raised px-4 py-3', clickable && 'hover:bg-surface-overlay/60')}>
      {clickable && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${label}: ${verdict}. Open ${opens}`}
          title={`Open ${opens}`}
          className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500"
        />
      )}
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {/* Above the button, so hovering the label explains it instead of opening the section. */}
        <span className="relative z-10">
          <Term k={term}>{label}</Term>
        </span>
      </p>
      <p className={cn('mt-1 text-[15px] font-semibold leading-tight tnum', TONE_CLASS[tone])}>{verdict}</p>
      <p className="mt-1 text-[11px] leading-snug tnum text-slate-400">{detail}</p>
    </div>
  );
}
