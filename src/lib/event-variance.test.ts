import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIQUIDITY_FLOOR,
  computeImpliedEventMove,
  extractPreEventReference,
  extractTwoPostEvent,
  selectBracket,
  tauYears,
  type ExpiryQuote,
} from './event-variance';

const liquid = { atmOpenInterest: 5000, quoteWidthFrac: 0.05 };
function q(expiry: string, iv: number, tradingDays: number, extra: Partial<ExpiryQuote> = {}): ExpiryQuote {
  return { expiry, iv, tradingDays, ...liquid, ...extra };
}

describe('extractPreEventReference (bracket A) — the hand-worked example', () => {
  // eventIv = 0.60, refIv = 0.30, eventDays = 10:
  //   τ_event = 10 / 252                         = 0.0396825
  //   σ_d²    = 0.30²                            = 0.09
  //   v_e     = (0.60² − 0.09) · τ_event
  //           = (0.36 − 0.09) · 0.0396825
  //           = 0.27 · 0.0396825                 = 0.01071429
  //   move    = sqrt(0.01071429)                 = 0.103510  → 10.35%
  it('reproduces the 10.35% implied event move', () => {
    const out = extractPreEventReference(q('2026-08-01', 0.3, 3), q('2026-08-08', 0.6, 10));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.diffusiveVar).toBeCloseTo(0.09, 10);
    expect(out.result.eventVar).toBeCloseTo(0.01071429, 8);
    expect(out.result.impliedMove).toBeCloseTo(0.103510, 6);
    expect(out.result.method).toBe('pre-event-reference');
  });

  it('rejects (not clamp) when the event expiry is not richer than the reference', () => {
    const out = extractPreEventReference(q('2026-08-01', 0.35, 3), q('2026-08-08', 0.3, 10));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/refusing to clamp/);
  });
});

describe('extractTwoPostEvent (bracket B)', () => {
  // Construct a known truth: σ_d = 0.30 (σ_d² = 0.09), v_e = 0.01071429.
  //   near: 15 td → τ = 0.0595238; V = 0.09·0.0595238 + 0.01071429 = 0.01607143
  //         σ_near = sqrt(V/τ) = sqrt(0.27)     = 0.5196152
  //   far:  30 td → τ = 0.1190476; V = 0.09·0.1190476 + 0.01071429 = 0.02142857
  //         σ_far  = sqrt(V/τ) = sqrt(0.18)     = 0.4242641
  it('recovers σ_d and v_e from two spanning expiries', () => {
    const out = extractTwoPostEvent(q('2026-08-15', Math.sqrt(0.27), 15), q('2026-08-30', Math.sqrt(0.18), 30));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.diffusiveVar).toBeCloseTo(0.09, 8);
    expect(out.result.eventVar).toBeCloseTo(0.01071429, 8);
    expect(out.result.impliedMove).toBeCloseTo(0.103510, 6);
    expect(out.result.method).toBe('two-post-event');
  });

  it('rejects (not clamp) when the near expiry is not elevated over the far', () => {
    // Ordinary upward term slope, no event: near IV < far IV → v_e < 0.
    const out = extractTwoPostEvent(q('2026-08-15', 0.28, 15), q('2026-08-30', 0.32, 30));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/refusing to clamp/);
  });
});

describe('selectBracket — adjacent bracketing only, liquidity floor', () => {
  const chain = [
    q('2026-08-01', 0.3, 3), // pre-event
    q('2026-08-08', 0.6, 10), // first post-event (event on td 7)
    q('2026-08-22', 0.45, 20),
  ];
  it('prefers bracket A when an adjacent pre-event expiry exists', () => {
    const sel = selectBracket(chain, 7);
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect(sel.selection.method).toBe('pre-event-reference');
    expect(sel.selection.reference.expiry).toBe('2026-08-01');
    expect(sel.selection.event.expiry).toBe('2026-08-08');
  });

  it('falls back to bracket B when there is no pre-event expiry', () => {
    const sel = selectBracket(chain, 1); // event before the earliest expiry
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect(sel.selection.method).toBe('two-post-event');
    expect(sel.selection.event.expiry).toBe('2026-08-01');
    expect(sel.selection.reference.expiry).toBe('2026-08-08');
  });

  it('refuses when the adjacent pair fails the liquidity floor (no distant reach)', () => {
    const illiquid = [
      q('2026-08-08', 0.6, 10, { atmOpenInterest: 5 }),
      q('2026-08-22', 0.45, 20, { atmOpenInterest: 5 }),
      q('2026-09-19', 0.4, 40), // liquid but distant — must NOT be reached for
    ];
    const sel = selectBracket(illiquid, 7, DEFAULT_LIQUIDITY_FLOOR);
    expect(sel.ok).toBe(false);
    if (sel.ok) return;
    expect(sel.reason).toMatch(/liquidity floor/);
  });

  it('refuses when no expiry spans the event', () => {
    const sel = selectBracket([q('2026-08-01', 0.3, 3)], 10);
    expect(sel.ok).toBe(false);
  });
});

describe('computeImpliedEventMove — end to end with audit logging', () => {
  it('logs the refusal reason and returns null on a non-positive variance', () => {
    const reasons: string[] = [];
    const chain = [q('2026-08-01', 0.35, 3), q('2026-08-08', 0.3, 10)];
    const res = computeImpliedEventMove(chain, 7, DEFAULT_LIQUIDITY_FLOOR, (r) => reasons.push(r));
    expect(res).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/refusing to clamp/);
  });

  it('returns the decomposition when the bracket is valid', () => {
    const chain = [q('2026-08-01', 0.3, 3), q('2026-08-08', 0.6, 10)];
    const res = computeImpliedEventMove(chain, 7);
    expect(res?.impliedMove).toBeCloseTo(0.103510, 6);
  });
});

describe('tauYears', () => {
  it('uses a 252 trading-day year', () => {
    expect(tauYears(252)).toBe(1);
    expect(tauYears(10)).toBeCloseTo(0.0396825, 7);
  });
});
