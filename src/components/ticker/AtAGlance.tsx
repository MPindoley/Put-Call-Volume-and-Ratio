'use client';

/**
 * The stock in one look: a few plain sentences, then six tiles — what is
 * happening (flow, positioning), what is priced (option prices, expected
 * move), what the app has learned (lean) and what is next (catalyst).
 */
import { GlanceBlock, GlanceTile } from '@/components/ui/glance';
import { glanceSentence, glanceTiles, type SectionId, type SummaryInput } from '@/lib/ticker-summary';

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
  return (
    <GlanceBlock label="At a glance" sentence={glanceSentence(input)}>
      {glanceTiles(input).map((t) => {
        const section = t.section;
        return (
          <GlanceTile
            key={t.id}
            label={t.label}
            term={t.term}
            verdict={t.verdict}
            detail={t.detail}
            tone={t.tone}
            opens={section ? titleOf(section) : null}
            onOpen={section ? () => onOpen(section) : undefined}
          />
        );
      })}
    </GlanceBlock>
  );
}
