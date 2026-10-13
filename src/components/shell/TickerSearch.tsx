'use client';

/**
 * One search box, in the top bar, on every page. Typing narrows the scan
 * table live (on the Scanner) and lists matching tickers underneath; Enter
 * jumps to the highlighted ticker's page. `/` focuses it from anywhere, Esc
 * clears it (KeyboardShortcuts).
 */
import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { cn, formatRatio } from '@/lib/utils';
import { matchTickers } from '@/lib/ticker-search';
import { useFlowStore } from '@/store/flowStore';

export function TickerSearch(): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const onScanner = pathname === '/';
  const search = useFlowStore((s) => s.search);
  const setSearch = useFlowStore((s) => s.setSearch);
  const rows = useFlowStore((s) => s.rows);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(
    () => matchTickers(search, (sym) => {
      const r = rows[sym];
      return r ? r.sessionPutVolume + r.sessionCallVolume : 0;
    }),
    // Re-rank as the term changes, not on every streamed row update.
    [search],
  );
  const open = focused && search.trim().length > 0;
  const tableMatches = useMemo(() => {
    const t = search.trim().toUpperCase();
    return t ? Object.keys(rows).filter((s) => s.includes(t)).length : 0;
  }, [rows, search]);

  const go = (symbol: string): void => {
    setSearch('');
    setFocused(false);
    (document.activeElement as HTMLElement | null)?.blur();
    router.push(`/ticker/${symbol}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActive((i) => Math.max(i - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const pick = matches[active]?.symbol ?? search.trim().toUpperCase();
      if (pick) go(pick);
      e.preventDefault();
    }
  };

  return (
    <div className="relative w-full max-w-xs">
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        id="ticker-search"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={onScanner ? 'Filter or jump to ticker' : 'Jump to ticker'}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="ticker-search-list"
        aria-activedescendant={open && matches[active] ? `ticker-opt-${matches[active]!.symbol}` : undefined}
        aria-label="Search tickers"
        className="h-8 w-full rounded-md border border-surface-border bg-surface pl-8 pr-8 text-xs uppercase text-slate-200 placeholder:normal-case placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-surface-border px-1 text-[10px] text-slate-500">
        /
      </kbd>

      {open && (
        <div className="absolute left-0 right-0 top-9 z-40 overflow-hidden rounded-md border border-surface-border bg-surface-raised shadow-2xl">
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500">
              No tracked ticker matches “{search.trim().toUpperCase()}”.
            </p>
          ) : (
            <ul id="ticker-search-list" role="listbox">
              {matches.map((m, i) => {
                const row = rows[m.symbol];
                return (
                  <li
                    key={m.symbol}
                    id={`ticker-opt-${m.symbol}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus so the click lands
                      go(m.symbol);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 px-3 py-1.5 text-xs',
                      i === active ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60',
                    )}
                  >
                    <span className="w-14 font-semibold text-slate-100">{m.symbol}</span>
                    <span className="flex-1 truncate text-slate-500">{m.sector}</span>
                    {row && row.lastUpdated > 0 && (
                      <span className={cn('tnum', row.putCallRatio > 1 ? 'text-bearish' : 'text-bullish')} title="Put/call ratio (5m)">
                        P/C {formatRatio(row.putCallRatio)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="flex justify-between border-t border-surface-border px-3 py-1.5 text-[10px] text-slate-500">
            <span>↵ open · ↑↓ select · esc clear</span>
            {onScanner && <span className="tnum">table: {tableMatches} match{tableMatches === 1 ? '' : 'es'}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
