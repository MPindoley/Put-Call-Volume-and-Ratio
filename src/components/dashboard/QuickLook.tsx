'use client';

/**
 * Quick look: one stock read from the scanner without leaving it. Clicking a
 * row (or an alert) puts that stock's at-a-glance summary and section
 * headlines in the side panel; ↑/↓ move through the list, Esc closes. Every
 * line links to the stock's page with that section opened.
 */
import Link from 'next/link';
import { GlanceBlock, GlanceTile } from '@/components/ui/glance';
import { Skeleton } from '@/components/ui/skeleton';
import { useTickerDetail } from '@/hooks/useTickerDetail';
import { formatMarketCap, marketCapOf } from '@/lib/market-cap';
import { glanceSentence, glanceTiles, sectionHeadlines, sectionList, type SummaryInput } from '@/lib/ticker-summary';
import { cn } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';

export function QuickLook({ symbol, onClose }: { symbol: string; onClose: () => void }): JSX.Element {
  const query = useTickerDetail(symbol);
  // The streamed row is fresher than the 15-second detail poll.
  const liveRow = useFlowStore((s) => s.rows[symbol]);
  const pinned = useFlowStore((s) => s.pinned.includes(symbol));
  const togglePin = useFlowStore((s) => s.togglePin);
  const flow = liveRow ?? query.data?.flow ?? null;
  const href = `/ticker/${encodeURIComponent(symbol)}`;

  const price = flow ? (flow.livePrice ?? (flow.underlyingPrice > 0 ? flow.underlyingPrice : null)) : null;
  const change = flow ? (flow.livePrice !== null ? flow.livePriceChangePct : flow.priceChangePct) : null;
  const cap = flow ? marketCapOf(flow) : null;

  const input: SummaryInput | null =
    query.data && flow
      ? {
          flow,
          projection: query.data.projection,
          calibration: query.data.calibration,
          trackRecord: query.data.trackRecord,
          historyCount: query.data.history.length,
        }
      : null;
  const defs = input ? sectionList(input) : [];
  const headlines = input ? sectionHeadlines(input) : null;
  const titleOf = (id: string): string | null => defs.find((d) => d.id === id)?.title ?? null;

  return (
    <aside
      aria-label={`Quick look: ${symbol}`}
      className="flex h-full min-h-0 flex-col rounded-lg border border-surface-border bg-surface-raised"
    >
      <div className="shrink-0 border-b border-surface-border px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-bold tracking-tight text-slate-100">{symbol}</h2>
          {price !== null && <span className="text-sm font-semibold tnum text-slate-100">{price.toFixed(2)}</span>}
          {change !== null && price !== null && (
            <span className={cn('text-xs tnum', change >= 0 ? 'text-bullish' : 'text-bearish')}>
              {change >= 0 ? '+' : ''}
              {change.toFixed(2)}%
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close quick look"
            className="ml-auto self-center rounded px-1.5 py-0.5 text-slate-500 hover:bg-surface-overlay hover:text-slate-200"
          >
            ✕
          </button>
        </div>
        {flow && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {flow.sector}
            {cap !== null && <span className="tnum"> · {formatMarketCap(cap)}</span>}
          </p>
        )}
        <div className="mt-2 flex gap-2">
          <Link
            href={href}
            prefetch={false}
            className="flex-1 rounded border border-blue-500/60 bg-blue-500/10 px-2 py-1 text-center text-xs font-medium text-slate-100 hover:bg-blue-500/20"
          >
            Open full page →
          </Link>
          <button
            type="button"
            onClick={() => togglePin(symbol)}
            className={cn(
              'rounded border px-2 py-1 text-xs',
              pinned ? 'border-caution/50 text-caution' : 'border-surface-border text-slate-400 hover:text-slate-200',
            )}
            title={pinned ? 'Unpin from the top of the scanner' : 'Pin to the top of the scanner'}
          >
            {pinned ? '★ Pinned' : '☆ Pin'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {query.isLoading ? (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-40 w-full" />
          </>
        ) : !input || !headlines ? (
          <p className="py-6 text-center text-xs leading-relaxed text-slate-400">
            {query.error?.message === 'pending'
              ? `${symbol}'s first snapshot has not arrived yet — quieter names load within about half an hour of a restart.`
              : `Could not load ${symbol} — retrying automatically.`}
          </p>
        ) : (
          <>
            <GlanceBlock label={`${symbol} at a glance`} sentence={glanceSentence(input)} narrow>
              {glanceTiles(input).map((t) => (
                <GlanceTile
                  key={t.id}
                  label={t.label}
                  term={t.term}
                  verdict={t.verdict}
                  detail={t.detail}
                  tone={t.tone}
                  opens={null}
                />
              ))}
            </GlanceBlock>

            <ul className="divide-y divide-surface-border/60 rounded-lg border border-surface-border">
              {defs.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`${href}#${d.id}`}
                    prefetch={false}
                    title={`Open ${titleOf(d.id)} on ${symbol}'s page`}
                    className="block px-3 py-1.5 hover:bg-surface-overlay/50"
                  >
                    <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{d.title}</span>
                    <span className="block text-[11px] leading-snug tnum text-slate-300">{headlines[d.id]}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-[10px] leading-relaxed text-slate-500">
              ↑ ↓ move through the list · Esc closes · underlined labels explain themselves on hover.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
