/**
 * Which tickers to refresh next, within the data source's rate budget.
 *
 * The old rule — watchlist, then spiking names, then whoever is stalest —
 * treats every name alike, so each one waits a full lap of the universe:
 * ~9 minutes for ~550 names at 60 requests/minute, and proportionally longer
 * as the universe grows. But activity is wildly uneven: the busiest hundred
 * names carry most of the option volume while the long tail trades a few
 * hundred contracts a day, whose 15-minute-delayed chain barely changes
 * between refreshes. So refresh by importance instead:
 *
 *   tier 1 — watchlist, spiking names, index benchmarks, and the most active
 *            names: base interval 3 minutes
 *   tier 2 — the next most active: 10 minutes
 *   tier 3 — everything else: 30 minutes
 *
 * The base intervals are then scaled together so total demand matches the
 * budget: when the universe asks for more refreshes per minute than the source
 * allows, every interval stretches by the same factor (priorities hold);
 * when it asks for fewer, they shrink — but never below MIN_INTERVAL_MS, since
 * the source cannot produce fresher data than that anyway. Each cycle takes the
 * names that are most overdue relative to their own interval, never-fetched
 * names first.
 *
 * Activity = today's session option volume once known, else the last recorded
 * day's, so the morning's first laps already favour the right names.
 *
 * Pure — no clock, no I/O — so the schedule is unit-tested.
 */

export interface RefreshCandidate {
  symbol: string;
  /** Epoch ms of the last fetch; 0 = never fetched. */
  lastFetched: number;
  /** Option contracts per session (today's so far, else the last recorded day's); 0 = unknown. */
  activity: number;
  /** On the user's watchlist. */
  watch: boolean;
  /** Currently flagged as unusual activity. */
  spiking: boolean;
  /** An index benchmark always shown on screen (SPY, QQQ, …). */
  benchmark: boolean;
}

export interface RefreshPlanItem {
  symbol: string;
  /** Token-bucket priority (lower = served first). */
  priority: number;
}

export interface ScheduleConfig {
  /** How many of the most active names join tier 1 / tier 2. */
  tier1Size: number;
  tier2Size: number;
  /** Base refresh intervals per tier, ms. */
  baseIntervalsMs: readonly [number, number, number];
}

const MIN = 60_000;
export const MIN_INTERVAL_MS = 1 * MIN;

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  tier1Size: 100,
  tier2Size: 300,
  baseIntervalsMs: [3 * MIN, 10 * MIN, 30 * MIN],
};

export type Tier = 1 | 2 | 3;

/** Tier per symbol: pinned names are tier 1; the rest by activity rank. */
export function assignTiers(candidates: readonly RefreshCandidate[], cfg = DEFAULT_SCHEDULE): Map<string, Tier> {
  const tiers = new Map<string, Tier>();
  const ranked = [...candidates].sort((a, b) => b.activity - a.activity || a.symbol.localeCompare(b.symbol));
  ranked.forEach((c, rank) => {
    const pinned = c.watch || c.spiking || c.benchmark;
    const byRank: Tier = c.activity > 0 && rank < cfg.tier1Size ? 1 : c.activity > 0 && rank < cfg.tier1Size + cfg.tier2Size ? 2 : 3;
    // No activity known (never seen and no history, or nothing traded yet) is
    // quiet until measured. A never-fetched name still gets its first fetch from
    // spare capacity (planRefresh), whatever its tier.
    tiers.set(c.symbol, pinned ? 1 : c.activity > 0 ? byRank : 3);
  });
  return tiers;
}

/**
 * Target refresh interval per symbol, scaled so the whole universe's demand
 * (Σ 1/interval) equals `perMinute` requests per minute.
 */
export function targetIntervals(
  candidates: readonly RefreshCandidate[],
  perMinute: number,
  cfg = DEFAULT_SCHEDULE,
): Map<string, number> {
  const tiers = assignTiers(candidates, cfg);
  const base = (t: Tier): number => cfg.baseIntervalsMs[t - 1] ?? cfg.baseIntervalsMs[2];
  const demandPerMin = candidates.reduce((sum, c) => sum + MIN / base(tiers.get(c.symbol) ?? 3), 0);
  const scale = perMinute > 0 && demandPerMin > 0 ? demandPerMin / perMinute : 1;
  const out = new Map<string, number>();
  for (const c of candidates) out.set(c.symbol, Math.max(MIN_INTERVAL_MS, base(tiers.get(c.symbol) ?? 3) * scale));
  return out;
}

/**
 * The next `budget` symbols to refresh, by how overdue each is relative to its
 * own target interval (elapsed ÷ interval), so a tier-1 name 4 minutes stale
 * outranks a tier-3 name 20 minutes stale.
 *
 * Order: names that are DUE (elapsed ≥ their interval) first, most overdue
 * first; then never-fetched names (busiest first); then the rest, nearest to
 * due first. A never-fetched name counts its elapsed time from when the
 * scheduler started (`startedAt`), so one still unfetched after a whole tail
 * interval becomes due like any other. Measured live at ~1,400 names, both
 * simpler rules failed after a restart: "never-fetched first" spent the whole
 * first ~16-minute pass on first fetches, so not even SPY got the second
 * snapshot a 5-minute rate needs; "most overdue first" kept re-fetching the
 * first hundred names long before they were due and stalled the backlog.
 */
export function planRefresh(
  candidates: readonly RefreshCandidate[],
  budget: number,
  perMinute: number,
  now: number,
  cfg = DEFAULT_SCHEDULE,
  startedAt = now,
): RefreshPlanItem[] {
  if (budget <= 0) return [];
  const intervals = targetIntervals(candidates, perMinute, cfg);
  const tiers = assignTiers(candidates, cfg);
  const scored = candidates.map((c) => {
    const interval = intervals.get(c.symbol) ?? 30 * MIN;
    const never = c.lastFetched === 0;
    const overdue = (now - (never ? startedAt : c.lastFetched)) / interval;
    const tier = tiers.get(c.symbol) ?? 3;
    const priority = c.watch ? 1 : c.spiking ? 2 : tier === 1 ? 3 : tier === 2 ? 5 : 7;
    return { symbol: c.symbol, overdue, never, priority, activity: c.activity };
  });
  const rank = (x: { overdue: number; never: boolean }): number => (x.overdue >= 1 ? 0 : x.never ? 1 : 2);
  scored.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 1 ? 0 : b.overdue - a.overdue) ||
      a.priority - b.priority ||
      b.activity - a.activity ||
      a.symbol.localeCompare(b.symbol),
  );
  return scored.slice(0, budget).map(({ symbol, priority }) => ({ symbol, priority }));
}

/**
 * Names whose data predates a session's close by more than `slackMs` (or that
 * have none) — what an after-hours catch-up must refresh. The slack keeps names
 * refreshed in the session's last minutes, whose figures are the close in all
 * but name, from being fetched again.
 */
export function staleForClose(
  symbols: readonly string[],
  dataAsOf: (symbol: string) => number,
  closeMs: number,
  slackMs = 20 * MIN,
): string[] {
  return symbols.filter((s) => dataAsOf(s) < closeMs - slackMs);
}
