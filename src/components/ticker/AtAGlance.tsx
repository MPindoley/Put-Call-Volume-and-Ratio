'use client';

/**
 * The stock in one look: a few plain sentences, then six tiles — what is
 * happening (flow, positioning), what is priced (option prices, expected
 * move), what the app has learned (lean) and what is next (catalyst). Each
 * tile gives an answer first and the numbers behind it second; its label
 * explains itself on hover, and the rest of the tile opens the section that
 * holds the detail.
 */
import { Term } from '@/components/ui/term';
import { glanceSentence, glanceTiles, type SectionId, type SummaryInput, type Tone } from '@/lib/ticker-summary';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<Tone, string> = {
  bullish: 'text-bullish',
  bearish: 'text-bearish',
  caution: 'text-caution',
  neutral: 'text-slate-100',
  muted: 'text-slate-500',
};

export function AtAGlance({
  input,
  titleOf,
  onOpen,
}: {
  input: SummaryInput;
  /** The title of a section on this page, or null when the page has no such section. */
  titleOf: (id: SectionId) => string | null;
  onOpen: (id: SectionId) => void;
}): JSX.Element {
  const tiles = glanceTiles(input);
  return (
    <section aria-label="At a glance" className="overflow-hidden rounded-lg border border-surface-border bg-surface-raised">
      <p className="px-4 py-3 text-sm leading-relaxed text-slate-200">{glanceSentence(input)}</p>
      {/* One-pixel gaps over the border colour draw the dividers between tiles at every column count. */}
      <div className="grid grid-cols-2 gap-px border-t border-surface-border bg-surface-border md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => {
          const target = t.section && titleOf(t.section) ? t.section : null;
          return (
            <div key={t.id} className={cn('relative bg-surface-raised px-4 py-3', target && 'hover:bg-surface-overlay/60')}>
              {target && (
                <button
                  type="button"
                  onClick={() => onOpen(target)}
                  aria-label={`${t.label}: ${t.verdict}. Open ${titleOf(target)}`}
                  title={`Open ${titleOf(target)}`}
                  className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500"
                />
              )}
              <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                <span className="relative z-10">
                  <Term k={t.term}>{t.label}</Term>
                </span>
              </p>
              <p className={cn('mt-1 text-[15px] font-semibold leading-tight tnum', TONE_CLASS[t.tone])}>{t.verdict}</p>
              <p className="mt-1 text-[11px] leading-snug tnum text-slate-400">{t.detail}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
