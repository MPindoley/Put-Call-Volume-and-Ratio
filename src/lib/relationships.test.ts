import { describe, expect, it } from 'vitest';
import {
  buildFeatureRows,
  coMovement,
  corrT,
  findAnalogs,
  FORWARD_SESSIONS,
  leadStats,
  spearman,
  type DayInput,
  type FeatureRow,
} from './relationships';

function day(session: number, close: number, extra: Partial<DayInput> = {}): DayInput {
  return {
    session,
    date: `d${session}`,
    close,
    iv30: null,
    termSlope: null,
    optVolume: null,
    skewZ30: null,
    ivZ30: null,
    oiPcZ30: null,
    ivHvZ30: null,
    ...extra,
  };
}

describe('spearman', () => {
  it('is 1 / −1 for any monotone relation and handles ties', () => {
    const x = [1, 2, 3, 4, 5, 6];
    expect(spearman(x, x.map((v) => v ** 3))).toBeCloseTo(1, 10);
    expect(spearman(x, x.map((v) => -v))).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1, 10);
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('counts overlap-adjusted evidence in its t', () => {
    expect(corrT(0.2, 102)).toBeCloseTo(0.2 * Math.sqrt(100 / 0.96), 6);
    expect(corrT(0.2, 2)).toBeNull();
  });
});

describe('buildFeatureRows', () => {
  it('measures forward and past excess returns against SPY, point in time', () => {
    const spy = new Map(Array.from({ length: 40 }, (_, i) => [i, 100 * 1.001 ** i] as const));
    const days = Array.from({ length: 40 }, (_, i) => day(i, 50 * 1.003 ** i, { iv30: 20 + i, optVolume: 1_000 + 10 * i }));
    const rows = buildFeatureRows('X', days, spy);
    const r0 = rows[0]!;
    expect(r0.fwd!).toBeCloseTo(FORWARD_SESSIONS * (Math.log(1.003) - Math.log(1.001)), 10);
    expect(rows[39]!.fwd).toBeNull(); // future not known yet
    expect(rows[10]!.features.mom5!).toBeCloseTo(5 * (Math.log(1.003) - Math.log(1.001)), 10);
    expect(rows[4]!.features.mom5).toBeUndefined();
    // IV rank needs 20 prior sessions; a rising IV ranks at the top of its own past.
    expect(rows[19]!.features.ivRank).toBeUndefined();
    expect(rows[20]!.features.ivRank).toBe(100);
    // Volume vs its trailing median needs 10 prior sessions.
    expect(rows[9]!.features.volRatio).toBeUndefined();
    expect(rows[10]!.features.volRatio).toBeGreaterThan(1);
  });
});

/** Rows where a feature truly leads the forward return (plus noise). */
function leadingRows(n: number, strength: number, symbol = 'X', offset = 0): FeatureRow[] {
  let s = 12_345;
  const noise = (): number => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648 - 0.5;
  };
  return Array.from({ length: n }, (_, i) => {
    const x = noise() * 4;
    return {
      symbol,
      session: offset + i,
      date: `d${offset + i}`,
      features: { skewZ: x, ivZ: noise() },
      fwd: strength * x * 0.01 + noise() * 0.02,
      ret1: null,
      regime: null,
    };
  });
}

describe('leadStats', () => {
  it('finds a real lead and states it as beat rates by fifth', () => {
    const s = leadStats(leadingRows(400, 1), 'skewZ', 40)!;
    expect(s.rho!).toBeGreaterThan(0.3);
    expect(s.notable).toBe(true);
    expect(s.top.beat!).toBeGreaterThan(s.bottom.beat!);
    expect(s.top.n).toBe(80);
    // n/10 effective observations, not n.
    expect(s.t!).toBeCloseTo(corrT(s.rho!, 40)!, 1);
  });

  it('refuses thin samples and calls noise non-notable', () => {
    expect(leadStats(leadingRows(30, 1), 'skewZ', 40)).toBeNull();
    const none = leadStats(leadingRows(400, 0), 'ivZ', 40)!;
    expect(none.notable).toBe(false);
  });
});

describe('coMovement', () => {
  it('correlates daily changes over consecutive sessions only', () => {
    const rows: FeatureRow[] = Array.from({ length: 60 }, (_, i) => ({
      symbol: 'X',
      session: i < 30 ? i : i + 5, // a gap: the pair across it is not a daily change
      date: `d${i}`,
      features: { skewZ: Math.sin(i) * 2, ivZ: -Math.sin(i) },
      fwd: null,
      ret1: Math.sin(i) - Math.sin(i - 1),
      regime: null,
    }));
    const m = coMovement(rows, 20);
    const at = (a: string, b: string): number | null => m.rho[m.keys.indexOf(a as never)]![m.keys.indexOf(b as never)]!;
    expect(at('skewZ', 'ivZ')).toBeCloseTo(-1, 5);
    expect(at('skewZ', 'ret')).toBeCloseTo(1, 5);
    expect(m.n[m.keys.indexOf('skewZ')]![m.keys.indexOf('ivZ')]).toBe(58);
    expect(at('termSlope', 'ret')).toBeNull();
  });
});

describe('findAnalogs', () => {
  const today: FeatureRow = {
    symbol: 'X',
    session: 999,
    date: 'today',
    features: { skewZ: 2, ivZ: 1, oiPcZ: -1, ivHvZ: 0.5 },
    fwd: null,
    ret1: null,
    regime: 'pos|pos',
  };

  it('finds the planted look-alikes and compares what followed with the base rate', () => {
    const pool: FeatureRow[] = [];
    // 200 ordinary sessions across 4 names: random setups, coin-flip outcomes.
    for (let i = 0; i < 200; i++) {
      pool.push({
        symbol: `P${i % 4}`,
        session: i * 3,
        date: `p${i}`,
        features: { skewZ: Math.sin(i) * 2 - 1, ivZ: Math.cos(i), oiPcZ: Math.sin(i * 2), ivHvZ: Math.cos(i * 3) },
        fwd: i % 2 ? 0.01 : -0.01,
        ret1: null,
        regime: 'pos|pos',
      });
    }
    // 30 sessions that look like today (spread across names/episodes), all followed by gains.
    for (let i = 0; i < 30; i++) {
      pool.push({
        symbol: `L${i % 6}`,
        session: 10_000 + i * 20,
        date: `l${i}`,
        features: { skewZ: 2 + i * 0.001, ivZ: 1, oiPcZ: -1, ivHvZ: 0.5 },
        fwd: 0.03,
        ret1: null,
        regime: 'pos|pos',
      });
    }
    const r = findAnalogs(today, pool);
    expect(r.summary).not.toBeNull();
    expect(r.analogs.length).toBe(25);
    expect(r.analogs.every((a) => a.symbol.startsWith('L'))).toBe(true);
    expect(r.summary!.beat).toBe(1);
    expect(r.summary!.baseBeat).toBeLessThan(0.6);
  });

  it('takes one analog per stock per 10-session episode', () => {
    const pool: FeatureRow[] = Array.from({ length: 80 }, (_, i) => ({
      symbol: 'SAME',
      session: i, // one long stretch of near-identical days
      date: `s${i}`,
      features: { skewZ: 2, ivZ: 1, oiPcZ: -1, ivHvZ: 0.5 + i * 0.0001 },
      fwd: 0.01,
      ret1: null,
      regime: null,
    }));
    const r = findAnalogs(today, pool);
    const sessions = r.analogs.map((a) => Number(a.date.slice(1))).sort((a, b) => a - b);
    for (let i = 1; i < sessions.length; i++) expect(sessions[i]! - sessions[i - 1]!).toBeGreaterThanOrEqual(FORWARD_SESSIONS);
  });

  it('says why when there is too little history', () => {
    expect(findAnalogs(today, leadingRows(20, 1)).reason).toMatch(/needs 60/);
    expect(findAnalogs({ ...today, features: { skewZ: 1 } }, []).reason).toMatch(/Only 1 of/);
    expect(findAnalogs(null, []).reason).toMatch(/No finalized session/);
  });
});
