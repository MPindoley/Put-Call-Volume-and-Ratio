/**
 * Who leads whom: names whose option positioning has tended to shift BEFORE
 * their sector moved. Pure; sector-leader-jobs.ts loads the rows.
 *
 * THE MEASURE. For each name in a cohort (a sector, or an industry group with
 * its own benchmark ETF): the rank correlation between
 *
 *   x — the day's CHANGE in the name's 25-delta risk-reversal skew
 *       (up = calls bid up against puts: positioning turning bullish), and
 *   y — the cohort benchmark's return over the NEXT session, in excess of SPY.
 *
 * A positive correlation means the name's skew turning bullish has tended to
 * come a session before its sector outperformed the market (and bearish
 * before underperformance); negative, the reverse.
 *
 * HONEST ABOUT HOW MANY WERE TESTED. A cohort has dozens of names, and with
 * that many some will correlate by luck. So a name is listed only past a
 * t-statistic of tCut (about 1 chance in 100 for a single test), the report
 * says how many names were tested and how many would clear that bar by chance
 * alone, and a name needs minObs sessions before it is tested at all. When
 * the listed count is no bigger than the chance count, there is no evidence
 * of a leader yet — and the page says so.
 *
 * EXPLORATORY. A correlation is not a mechanism, the feed is delayed and
 * daily, and "next session" is one day: this ranks candidates worth watching,
 * it does not feed the learned lean.
 */
import { corrT, spearman } from './relationships';

export const LEADER_PARAMS = {
  /** Sessions with a skew change and a next-session sector move before a name is tested. */
  minObs: 40,
  /** |t| a name must clear to be listed. */
  tCut: 2.6,
  /** Share of tests clearing tCut by chance alone (two-sided, large samples). */
  chanceRate: 0.0093,
  /** Strongest names shown when nothing clears the bar. */
  showStrongest: 5,
} as const;

export interface LeaderInput {
  symbol: string;
  /** The name's risk-reversal skew by session index (consecutive sessions differ by 1). */
  skew: ReadonlyMap<number, number>;
}

export interface LeaderRow {
  symbol: string;
  /** Sessions behind the correlation. */
  n: number;
  /** Spearman rank correlation of its skew change with the cohort's next-session excess return. */
  rho: number;
  t: number;
}

export interface LeadersResult {
  /** Names with enough sessions to test. */
  tested: number;
  /** How many of them would clear the bar by chance alone. */
  expectedByChance: number;
  /** Names past the bar, strongest first. */
  leaders: LeaderRow[];
  /** The strongest few regardless of the bar — shown, clearly labelled, when nothing clears it. */
  strongest: LeaderRow[];
}

/** ln(close[s+1] / close[s]), or null without both closes. */
function nextReturn(close: ReadonlyMap<number, number>, s: number): number | null {
  const a = close.get(s);
  const b = close.get(s + 1);
  return a && b && a > 0 && b > 0 ? Math.log(b / a) : null;
}

/** Rank every name in a cohort by how its skew changes have lined up with the cohort's next-session move. */
export function sectorLeaders(
  names: readonly LeaderInput[],
  benchmarkClose: ReadonlyMap<number, number>,
  spyClose: ReadonlyMap<number, number>,
  p: { minObs: number; tCut: number; chanceRate: number; showStrongest: number } = LEADER_PARAMS,
): LeadersResult {
  const rows: LeaderRow[] = [];
  for (const name of names) {
    const x: number[] = [];
    const y: number[] = [];
    for (const [session, skew] of name.skew) {
      const prev = name.skew.get(session - 1);
      if (prev === undefined) continue;
      const bench = nextReturn(benchmarkClose, session);
      const spy = nextReturn(spyClose, session);
      if (bench === null || spy === null) continue;
      x.push(skew - prev);
      y.push(bench - spy);
    }
    if (x.length < p.minObs) continue;
    const rho = spearman(x, y);
    // A perfect rank correlation has no finite t: read it as just short of perfect.
    const t = rho === null ? null : corrT(Math.max(-0.9999, Math.min(0.9999, rho)), x.length);
    if (rho === null || t === null) continue;
    rows.push({ symbol: name.symbol, n: x.length, rho: Number(rho.toFixed(3)), t: Number(t.toFixed(2)) });
  }
  rows.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  return {
    tested: rows.length,
    expectedByChance: Number((rows.length * p.chanceRate).toFixed(1)),
    leaders: rows.filter((r) => Math.abs(r.t) >= p.tCut),
    strongest: rows.slice(0, p.showStrongest),
  };
}
