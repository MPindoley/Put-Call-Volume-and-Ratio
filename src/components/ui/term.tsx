'use client';

/**
 * A defined term: dotted underline, definition on hover, keyboard focus or
 * tap (glossary.ts). The popover is portalled to <body> with fixed
 * positioning, so scrolling cards and tables never clip it.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY, type GlossaryEntry, type GlossaryKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';

const WIDTH = 300;
const MARGIN = 12;

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
}

export function Term({ k, children, className }: { k: GlossaryKey; children?: ReactNode; className?: string }): JSX.Element {
  const entry: GlossaryEntry = GLOSSARY[k];
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);

  const measure = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - WIDTH - MARGIN);
    // Below the term when there is room, otherwise above it.
    setPlace(window.innerHeight - r.bottom > 240 ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  }, []);

  const show = (): void => {
    measure();
    setOpen(true);
  };
  const hide = (): void => {
    if (!pinned) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      setOpen(false);
      setPinned(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={() => {
          setPinned(false);
          setOpen(false);
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Tap (touch) or click keeps it open until dismissed.
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            show();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPinned((p) => !p);
            show();
          }
        }}
        className={cn(
          'cursor-help underline decoration-slate-600 decoration-dotted underline-offset-[3px] hover:decoration-slate-400 focus:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-blue-500',
          className,
        )}
      >
        {children ?? entry.term}
      </span>
      {open &&
        place &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ position: 'fixed', left: place.left, top: place.top, bottom: place.bottom, width: WIDTH }}
            className="pointer-events-none z-[100] rounded-md border border-surface-border bg-surface-overlay p-3 text-left text-[11px] normal-case leading-relaxed tracking-normal text-slate-300 shadow-xl shadow-black/40"
          >
            <p className="mb-1 text-xs font-semibold text-slate-100">{entry.term}</p>
            <p>{entry.what}</p>
            {entry.how && (
              <p className="mt-1.5">
                <span className="font-medium text-slate-400">How: </span>
                {entry.how}
              </p>
            )}
            {entry.read && (
              <p className="mt-1.5">
                <span className="font-medium text-slate-400">Reading it: </span>
                {entry.read}
              </p>
            )}
            {entry.caveat && <p className="mt-1.5 text-caution/90">{entry.caveat}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
