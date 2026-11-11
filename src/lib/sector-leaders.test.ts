import { describe, expect, it } from 'vitest';
import { LEADER_PARAMS, sectorLeaders, type LeaderInput } from './sector-leaders';

/** A seeded uniform generator, so the statistical checks are deterministic. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (s + 0.5) / 2_147_483_648;
  };
}

const N = 120;
const u = rng(11);
/** The benchmark's daily excess return over SPY (SPY is flat here). */
const move = Array.from({ length: N }, () => (u() - 0.5) * 0.02);
const bench = new Map<number, number>();
const spy = new Map<number, number>();
let close = 100;
for (let s = 0; s <= N; s++) {
  bench.set(s, close);
  spy.set(s, 500);
  close *= Math.exp(move[s] ?? 0);
}
/** A skew series whose change on session s is `change(s)`. */
function name(symbol: string, change: (s: number) => number, from = 0): LeaderInput {
  const skew = new Map<number, number>();
  let level = 0;
  for (let s = from; s < N; s++) {
    level += change(s);
    skew.set(s, level);
  }
  return { symbol, skew };
}

describe('sectorLeaders', () => {
  const noise = rng(5);
  // LEAD's skew moves today the way the benchmark will move tomorrow (plus noise);
  // LAG's moves the way the benchmark moved yesterday; NOISE is unrelated.
  const lead = name('LEAD', (s) => (move[s] ?? 0) * 40 + (noise() - 0.5) * 0.3);
  const inverse = name('INV', (s) => -(move[s] ?? 0) * 40 + (noise() - 0.5) * 0.3);
  const lag = name('LAG', (s) => (move[s - 2] ?? 0) * 40 + (noise() - 0.5) * 0.3);
  const random = name('NOISE', () => noise() - 0.5);
  const young = name('YOUNG', (s) => (move[s] ?? 0) * 40, N - 20);

  const r = sectorLeaders([lead, inverse, lag, random, young], bench, spy);

  it('finds the name whose positioning shifts before the group moves, with the sign of the relation', () => {
    expect(r.leaders.map((x) => x.symbol).sort()).toEqual(['INV', 'LEAD']);
    const top = r.leaders.find((x) => x.symbol === 'LEAD')!;
    expect(top.rho).toBeGreaterThan(0.5);
    expect(top.t).toBeGreaterThan(LEADER_PARAMS.tCut);
    expect(r.leaders.find((x) => x.symbol === 'INV')!.rho).toBeLessThan(-0.5);
  });

  it('does not credit a name that follows the group, or one that is unrelated', () => {
    const t = (symbol: string): number => Math.abs(r.strongest.concat(r.leaders).find((x) => x.symbol === symbol)?.t ?? 0);
    expect(r.leaders.some((x) => x.symbol === 'LAG' || x.symbol === 'NOISE')).toBe(false);
    expect(t('LAG')).toBeLessThan(LEADER_PARAMS.tCut);
  });

  it('tests only names with enough sessions, and says how many would clear the bar by chance', () => {
    expect(r.tested).toBe(4); // YOUNG has 19 changes: not tested, not listed
    expect(r.strongest.some((x) => x.symbol === 'YOUNG')).toBe(false);
    expect(r.expectedByChance).toBeCloseTo(4 * LEADER_PARAMS.chanceRate, 1);
    expect(r.leaders.find((x) => x.symbol === 'LEAD')!.n).toBe(lead.skew.size - 1); // every session but the first has a change
  });

  it('lists nothing as a leader when nothing clears the bar, and still shows the strongest', () => {
    const quiet = sectorLeaders([random, lag], bench, spy);
    expect(quiet.leaders).toEqual([]);
    expect(quiet.strongest.length).toBe(2);
    expect(sectorLeaders([], bench, spy)).toEqual({ tested: 0, expectedByChance: 0, leaders: [], strongest: [] });
  });

  it('uses only consecutive sessions for a change, and skips sessions without the group’s next close', () => {
    const gappy: LeaderInput = { symbol: 'GAP', skew: new Map([...lead.skew].filter(([s]) => s % 3 !== 0)) };
    const g = sectorLeaders([gappy], bench, spy, { ...LEADER_PARAMS, minObs: 10 });
    expect(g.tested).toBe(1);
    expect(g.strongest[0]!.n).toBeLessThan(lead.skew.size / 2); // one usable change per three sessions
    const short = new Map([...bench].filter(([s]) => s < 60));
    expect(sectorLeaders([lead], short, spy, { ...LEADER_PARAMS, minObs: 10 }).strongest[0]!.n).toBe(58);
  });
});
