'use client';

/** Learned-conviction chip and live-quote staleness, shared by the scan table and the ticker header. */
import { cn } from '@/lib/utils';
import type { TickerFlow } from '@/types';

/** A live quote older than this reads as stale and is visibly dimmed. */
export const QUOTE_STALE_MS = 180_000;

/** Conviction (hit-rate points above base) at which the cell's tint saturates. */
const CONVICTION_SATURATE = 0.08;

const SIGNAL_LABELS: Record<string, string> = {
  skew_z: 'Skew z',
  divergence: 'Divergence',
  pc_extreme: 'OI P/C extreme',
  spike_alert: 'Volume spike',
};

/**
 * Learned conviction. Unlike the z-score columns this IS printed: it is sparse
 * (only names with a signal this session) and it is the headline. Tint follows
 * one-meaning-per-colour (green bullish / red bearish), intensity ∝ magnitude.
 * "—" when there is no signal or the net is below the display floor — never a
 * confident-looking number manufactured from thin evidence (§4).
 */
export function ConvictionCell({ row }: { row: TickerFlow }): JSX.Element {
  const c = row.conviction;
  if (!c || c.direction === null) {
    return (
      <span
        className="tnum text-slate-600"
        title={c ? `Signals fired ${c.asOf}, but learned evidence nets to ~0 — nothing worth claiming` : 'No signal this session'}
      >
        —
      </span>
    );
  }
  const pts = c.score * 100;
  const intensity = Math.min(Math.abs(c.score) / CONVICTION_SATURATE, 1);
  const rgb = c.direction === 'bullish' ? '74,222,128' : '248,113,113';
  const detail = c.parts
    .map(
      (p) =>
        `${SIGNAL_LABELS[p.signalType] ?? p.signalType} ${p.direction}: ${p.edge >= 0 ? '+' : ''}${(p.edge * 100).toFixed(1)} pts (n=${p.n})`,
    )
    .join('\n');
  return (
    <span
      className={cn('rounded-sm px-1 tnum', c.direction === 'bullish' ? 'text-bullish' : 'text-bearish')}
      style={{ backgroundColor: `rgba(${rgb},${(0.08 + intensity * 0.32).toFixed(2)})` }}
      title={`Learned ${c.direction} lean ${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts above base (signals of ${c.asOf})\n${detail}`}
    >
      {pts >= 0 ? '+' : ''}
      {Math.abs(pts) < 10 ? pts.toFixed(1) : pts.toFixed(0)}
    </span>
  );
}
