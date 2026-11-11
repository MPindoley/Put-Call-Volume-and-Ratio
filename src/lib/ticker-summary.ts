/**
 * The stock page in a few words: the at-a-glance tiles and sentence at the top,
 * and the headline shown on each drop-down section, so a closed section still
 * says what is inside it. Pure — every string is derived from data the page
 * already has, and a missing input reads as "not yet", never as a number.
 */
import type { GlossaryKey } from './glossary';
import type { TrackRecord } from './learning-data';
import { standing } from './own-normal';
import type { ExpiryProjection, Projection } from './projection';
import { ratioInForce, type CalibrationView, type HorizonKey } from './projection-history';
import { timingShort } from './signal-timing';
import { formatCompact } from './utils';
import type { TickerFlow } from '@/types';

export interface SummaryInput {
  flow: TickerFlow;
  projection: Projection | null;
  calibration: Record<HorizonKey, CalibrationView> | null;
  trackRecord: TrackRecord | null;
  /** Stored 5-minute snapshots shown in the history table. */
  historyCount: number;
}

// ── Wording shared by the headlines and the at-a-glance tiles ────────────────

/** A price for a range: whole dollars from $100, a decimal below, cents below $10. */
export const rangePrice = (v: number): string => `$${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}`;

/** "Nov 13" from a YYYY-MM-DD date. */
export const shortDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Fri Nov 13". */
export const weekdayDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Signed hit-rate points: 0.031 → "+3.1". */
export const points = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;

const signed = (x: number, digits: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`;

/** Put/call volume above this reads as put-heavy; below CALL_HEAVY as call-heavy (single stocks usually run 0.5–0.8). */
export const PUT_HEAVY = 1.1;
export const CALL_HEAVY = 0.6;

export type FlowLean = 'call-heavy' | 'put-heavy' | 'balanced';

export function flowLean(putCallRatio: number): FlowLean | null {
  if (!Number.isFinite(putCallRatio) || putCallRatio <= 0) return null;
  return putCallRatio >= PUT_HEAVY ? 'put-heavy' : putCallRatio <= CALL_HEAVY ? 'call-heavy' : 'balanced';
}

export const OWN_STANDING_TEXT = { high: 'unusually put-heavy', low: 'unusually call-heavy', normal: 'normal for it' } as const;

/**
 * The expiry nearest `days` calendar days out. Expiries about to lapse (under a
 * day and a half) are skipped when a later one exists: their range is mostly
 * today's noise.
 */
export function expiryNear(p: Projection | null, days: number): ExpiryProjection | null {
  if (!p || p.expiries.length === 0) return null;
  const live = p.expiries.filter((e) => e.dte >= 1.5);
  const pool = live.length > 0 ? live : p.expiries;
  return pool.reduce((best, e) => (Math.abs(e.dte - days) < Math.abs(best.dte - days) ? e : best));
}

/** The market-priced 68% range of an expiry, and its half-width as a share of today's price. */
export function range68(e: ExpiryProjection, spot: number): { lo: number; hi: number; pct: number | null } {
  const lo = e.quantiles[1]!;
  const hi = e.quantiles[3]!;
  return { lo, hi, pct: spot > 0 ? (hi - lo) / 2 / spot : null };
}

/** The sector-relative metric furthest from its own norm (30-day z), if any is measured. */
export function widestZ(flow: TickerFlow): { label: string; z: number } | null {
  const r = flow.sectorRelative;
  if (!r) return null;
  const all: { label: string; z: number | null }[] = [
    { label: 'skew', z: r.skewZ30 },
    { label: 'IV', z: r.ivZ30 },
    { label: 'OI put/call', z: r.oiPcZ30 },
    { label: 'IV − HV', z: r.ivHvZ30 },
  ];
  const measured = all.filter((m): m is { label: string; z: number } => m.z !== null && Number.isFinite(m.z));
  if (measured.length === 0) return null;
  return measured.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
}

/** The stock's own graded signals, all types together. */
export function ownRecord(record: TrackRecord | null): { hits: number; graded: number } {
  const rows = record?.bySignal ?? [];
  return { hits: rows.reduce((s, b) => s + b.hits, 0), graded: rows.reduce((s, b) => s + b.graded, 0) };
}

const TIMING_TEXT = { bmo: 'before the open', amc: 'after the close', unknown: '' } as const;

// ── Section headlines ────────────────────────────────────────────────────────

export type SectionId =
  | 'projection'
  | 'overview'
  | 'volatility'
  | 'relative'
  | 'track-record'
  | 'event'
  | 'idiosyncratic'
  | 'time-of-day'
  | 'relationships'
  | 'history';

export interface SectionDef {
  id: SectionId;
  title: string;
}

/** Which sections a stock has, in reading order (sections with nothing to show are skipped). */
export function sectionList({ flow, trackRecord }: Pick<SummaryInput, 'flow' | 'trackRecord'>): SectionDef[] {
  const out: SectionDef[] = [
    { id: 'projection', title: 'Projection' },
    { id: 'overview', title: 'Flow now' },
  ];
  if (flow.analytics || flow.iv30 !== null) out.push({ id: 'volatility', title: 'Volatility & positioning' });
  out.push({ id: 'relative', title: 'Versus its sector' });
  if (trackRecord) out.push({ id: 'track-record', title: 'Track record' });
  if (flow.eventGauge) out.push({ id: 'event', title: 'Event move' });
  if (flow.idiosyncraticMoves.length > 0) out.push({ id: 'idiosyncratic', title: 'Unusual moves' });
  out.push({ id: 'time-of-day', title: 'Time of day' });
  out.push({ id: 'relationships', title: 'Relationships' });
  out.push({ id: 'history', title: 'Stored snapshots' });
  return out;
}

function projectionHeadline({ flow, projection }: SummaryInput): string {
  const week = expiryNear(projection, 7);
  if (!projection || !week) return 'Waiting for the option chain';
  const spot = flow.livePrice ?? projection.spot;
  const month = expiryNear(projection, 30);
  const part = (e: ExpiryProjection): string => {
    const r = range68(e, spot);
    return `${rangePrice(r.lo)}–${rangePrice(r.hi)} by ${shortDate(e.expiration)}`;
  };
  return `68% range ${part(week)}${month && month.expiration !== week.expiration ? ` · ${part(month)}` : ''}`;
}

function overviewHeadline({ flow }: SummaryInput): string {
  const parts = [`P/C ${Number.isFinite(flow.putCallRatio) ? flow.putCallRatio.toFixed(2) : '—'}`];
  // Zero means "not measured yet" (no volume seen since the last restart), not "no volume".
  if (flow.volumeVsExpected > 0) parts.push(`${flow.volumeVsExpected.toFixed(1)}× usual volume`);
  if (flow.flowWindowMs !== null && flow.netFlow !== 0) {
    parts.push(`net ${formatCompact(Math.abs(flow.netFlow))} ${flow.netFlow > 0 ? 'calls' : 'puts'} per 5 min`);
  }
  if (flow.spikeLevel !== 'normal') parts.push(`${flow.spikeLevel} activity`);
  return parts.join(' · ');
}

function volatilityHeadline({ flow }: SummaryInput): string {
  const a = flow.analytics;
  const parts: string[] = [];
  if (flow.iv30 !== null) parts.push(`IV30 ${flow.iv30.toFixed(1)}${flow.ivRank !== null ? ` (rank ${flow.ivRank})` : ''}`);
  if (a && a.oiPutCall !== null) {
    const st = standing(a.oiPutCall, flow.ownPc);
    parts.push(`OI P/C ${a.oiPutCall.toFixed(2)}${st ? `, ${OWN_STANDING_TEXT[st]}` : ''}`);
  }
  if (a?.backwardated) parts.push('near-term IV above longer-term');
  return parts.length > 0 ? parts.join(' · ') : 'No volatility data yet';
}

function relativeHeadline({ flow }: SummaryInput): string {
  const r = flow.sectorRelative;
  if (!r) return 'Builds after the first end-of-day capture';
  const parts: string[] = [];
  const w = widestZ(flow);
  if (w) parts.push(Math.abs(w.z) >= 1 ? `Furthest from its sector: ${w.label} ${signed(w.z, 1)}σ` : 'In line with its sector');
  if (r.divergence) parts.push(r.divergence === 'distribution' ? 'distribution warning' : 'accumulation warning');
  if (r.regimeDetach) parts.push('regime shift');
  return parts.length > 0 ? parts.join(' · ') : 'Not enough history to score yet';
}

function trackRecordHeadline({ flow, trackRecord }: SummaryInput): string {
  const c = flow.conviction;
  const parts: string[] = [];
  if (c?.direction) {
    parts.push(`Leans ${c.direction} ${points(c.score)} pts`);
    parts.push(`${c.parts.length} signal${c.parts.length === 1 ? '' : 's'} this session`);
  } else {
    parts.push(c ? 'Signals net to no clear lean' : 'No signal this session');
  }
  const own = ownRecord(trackRecord);
  if (own.graded > 0) parts.push(`own record ${own.hits} of ${own.graded} hit`);
  return parts.join(' · ');
}

function eventHeadline({ flow }: SummaryInput): string {
  const g = flow.eventGauge;
  if (!g) return '';
  const parts: string[] = [];
  if (g.eventDate) {
    const when = g.reportTiming ? TIMING_TEXT[g.reportTiming] : '';
    parts.push(
      `${g.eventSource === 'bulge' ? 'Possible catalyst' : 'Catalyst'} ${shortDate(g.eventDate)}${when ? ` ${when}` : ''}`,
    );
  } else {
    parts.push('No catalyst dated');
  }
  if (g.impliedMove !== null) parts.push(`±${(g.impliedMove * 100).toFixed(1)}% priced`);
  if (g.display && g.percentile !== null) {
    parts.push(
      g.percentile >= 70
        ? 'rich vs its past reactions'
        : g.percentile <= 30
          ? 'cheap vs its past reactions'
          : 'fairly priced vs its past',
    );
  }
  return parts.join(' · ');
}

function idiosyncraticHeadline({ flow }: SummaryInput): string {
  const moves = flow.idiosyncraticMoves ?? [];
  if (moves.length === 0) return '';
  const latest = moves[0]!;
  return `${moves.length} unusual move${moves.length === 1 ? '' : 's'} on record · latest ±${(latest.movePct * 100).toFixed(1)}% on ${shortDate(latest.date)}`;
}

/** One line per section, keyed by section id. An empty string means "nothing to add to the title". */
export function sectionHeadlines(input: SummaryInput): Record<SectionId, string> {
  return {
    projection: projectionHeadline(input),
    overview: overviewHeadline(input),
    volatility: volatilityHeadline(input),
    relative: relativeHeadline(input),
    'track-record': trackRecordHeadline(input),
    event: eventHeadline(input),
    idiosyncratic: idiosyncraticHeadline(input),
    'time-of-day': 'When its volume usually arrives · what followed past spikes',
    relationships: 'What has come before its moves · similar past setups',
    history:
      input.historyCount > 0
        ? `${Math.min(input.historyCount, 100)} stored 5-minute snapshot${input.historyCount === 1 ? '' : 's'}`
        : 'No stored snapshots yet',
  };
}

// ── At a glance ──────────────────────────────────────────────────────────────

/** IV rank at or above this reads as expensive options; at or below CHEAP_RANK as cheap. */
export const EXPENSIVE_RANK = 75;
export const CHEAP_RANK = 25;

export type Tone = 'bullish' | 'bearish' | 'caution' | 'neutral' | 'muted';

export interface GlanceTile {
  id: 'flow' | 'positioning' | 'pricing' | 'move' | 'lean' | 'coming';
  label: string;
  /** Glossary entry behind the label: what the tile is, how it is worked out, how to read it. */
  term: GlossaryKey;
  /** The answer, in a few words. */
  verdict: string;
  /** The numbers behind it. */
  detail: string;
  tone: Tone;
  /** The section holding the detail, when there is one to open. */
  section: SectionId | null;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function flowTile({ flow }: SummaryInput): GlanceTile {
  const lean = flowLean(flow.putCallRatio);
  const busy = flow.spikeLevel !== 'normal';
  const detail: string[] = [];
  if (lean !== null) detail.push(`P/C ${flow.putCallRatio.toFixed(2)}`);
  if (flow.volumeVsExpected > 0) detail.push(`${flow.volumeVsExpected.toFixed(1)}× usual volume`);
  if (busy) detail.push(`${flow.spikeLevel} activity`);
  // An inverse product's calls are bets against what it tracks, so green/red would point the wrong way.
  const tone: Tone =
    lean === null
      ? 'muted'
      : flow.inverse || lean === 'balanced'
        ? busy
          ? 'caution'
          : 'neutral'
        : lean === 'call-heavy'
          ? 'bullish'
          : 'bearish';
  return {
    id: 'flow',
    label: 'Flow now',
    term: 'glanceFlow',
    verdict: lean === null ? 'No flow yet' : capital(lean),
    detail: detail.length > 0 ? detail.join(' · ') : 'Waiting for the first volume of the session',
    tone,
    section: 'overview',
  };
}

function positioningTile({ flow }: SummaryInput): GlanceTile {
  const base = { id: 'positioning', label: 'Positioning', term: 'glancePositioning' } as const;
  const pc = flow.analytics?.oiPutCall ?? null;
  if (pc === null) {
    return {
      ...base,
      verdict: 'No data yet',
      detail: 'Open interest arrives with the option chain',
      tone: 'muted',
      section: null,
    };
  }
  const st = standing(pc, flow.ownPc);
  if (!st || !flow.ownPc) {
    return {
      ...base,
      verdict: `OI P/C ${pc.toFixed(2)}`,
      detail: 'Still learning its usual range',
      tone: 'neutral',
      section: 'volatility',
    };
  }
  return {
    ...base,
    verdict: capital(OWN_STANDING_TEXT[st]),
    detail: `OI P/C ${pc.toFixed(2)} · usually ${flow.ownPc.lo.toFixed(2)}–${flow.ownPc.hi.toFixed(2)}`,
    tone: st === 'normal' ? 'neutral' : 'caution',
    section: 'volatility',
  };
}

function pricingTile({ flow }: SummaryInput): GlanceTile {
  const base = { id: 'pricing', label: 'Option prices', term: 'glancePricing' } as const;
  if (flow.iv30 === null) {
    return {
      ...base,
      verdict: 'No data yet',
      detail: 'Implied volatility arrives with the option chain',
      tone: 'muted',
      section: null,
    };
  }
  const realized = flow.hv20 !== null ? ` · realized ${flow.hv20.toFixed(1)}` : '';
  if (flow.ivRank === null) {
    return {
      ...base,
      verdict: `IV ${flow.iv30.toFixed(1)}`,
      detail: `Rank builds with stored history${realized}`,
      tone: 'neutral',
      section: 'volatility',
    };
  }
  const dear = flow.ivRank >= EXPENSIVE_RANK;
  return {
    ...base,
    verdict: dear ? 'Expensive for it' : flow.ivRank <= CHEAP_RANK ? 'Cheap for it' : 'Typical for it',
    detail: `IV ${flow.iv30.toFixed(1)} · rank ${flow.ivRank} of 100${realized}`,
    tone: dear ? 'caution' : 'neutral',
    section: 'volatility',
  };
}

function moveTile({ flow, projection, calibration }: SummaryInput): GlanceTile {
  const base = { id: 'move', label: 'Expected move', term: 'glanceMove' } as const;
  const e = expiryNear(projection, 7);
  if (projection && e) {
    const r = range68(e, flow.livePrice ?? projection.spot);
    const cal = calibration?.[e.dte <= 15 ? 'week' : 'month'] ?? null;
    return {
      ...base,
      verdict: `${r.pct !== null ? `±${(r.pct * 100).toFixed(1)}% ` : ''}by ${shortDate(e.expiration)}`,
      detail: `68% range ${rangePrice(r.lo)}–${rangePrice(r.hi)}${cal?.usable ? ` · real moves have run ${ratioInForce(cal).toFixed(2)}× priced` : ''}`,
      tone: 'neutral',
      section: 'projection',
    };
  }
  const straddle = flow.analytics?.impliedMovePct ?? null;
  if (straddle !== null) {
    return {
      ...base,
      verdict: `±${straddle.toFixed(1)}%`,
      detail: 'Priced by the nearest expiry',
      tone: 'neutral',
      section: 'volatility',
    };
  }
  return { ...base, verdict: 'No data yet', detail: 'Arrives with the option chain', tone: 'muted', section: null };
}

function leanTile({ flow, trackRecord }: SummaryInput): GlanceTile {
  const base = { id: 'lean', label: 'Learned lean', term: 'glanceLean' } as const;
  const section: SectionId | null = trackRecord ? 'track-record' : null;
  const c = flow.conviction;
  if (!c) return { ...base, verdict: 'No signal today', detail: 'Nothing with a track record fired', tone: 'muted', section };
  if (!c.direction)
    return { ...base, verdict: 'No clear lean', detail: 'Signals fired but net to about zero', tone: 'neutral', section };
  const detail = [`${c.parts.length} signal${c.parts.length === 1 ? '' : 's'}`];
  // How long the strongest of them has taken to play out, when that has been learned.
  const strongest = [...c.parts].sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))[0];
  const timing = trackRecord?.learned.find(
    (l) => l.signalType === strongest?.signalType && l.direction === strongest?.direction,
  )?.timing;
  if (timing && ['fast', 'mid', 'slow', 'steady'].includes(timing.verdict)) detail.push(`plays out over ${timingShort(timing)}`);
  return {
    ...base,
    verdict: `${capital(c.direction)} ${points(c.score)} pts`,
    detail: detail.join(' · '),
    tone: c.direction,
    section,
  };
}

function comingTile({ flow }: SummaryInput): GlanceTile {
  const base = { id: 'coming', label: 'Coming up', term: 'glanceComing' } as const;
  const g = flow.eventGauge;
  if (g?.eventDate) {
    const detail: string[] = [];
    const when = g.reportTiming ? TIMING_TEXT[g.reportTiming] : '';
    if (when) detail.push(capital(when));
    if (g.impliedMove !== null) detail.push(`±${(g.impliedMove * 100).toFixed(1)}% priced`);
    if (g.display && g.percentile !== null && (g.percentile >= 70 || g.percentile <= 30)) {
      detail.push(g.percentile >= 70 ? 'rich vs past' : 'cheap vs past');
    }
    return {
      ...base,
      verdict: `${g.eventSource === 'bulge' ? 'Possible catalyst' : 'Catalyst'} ${shortDate(g.eventDate)}`,
      detail: detail.length > 0 ? detail.join(' · ') : 'No move priced for it yet',
      tone: 'caution',
      section: 'event',
    };
  }
  const expiry = flow.analytics?.eventExpiry ?? null;
  if (expiry) {
    return {
      ...base,
      verdict: `Possible catalyst by ${shortDate(expiry)}`,
      detail: 'That expiry carries extra implied volatility',
      tone: 'caution',
      section: 'volatility',
    };
  }
  const last = flow.idiosyncraticMoves[0];
  return {
    ...base,
    verdict: 'Nothing dated',
    detail: last
      ? `Last unusual move ±${(last.movePct * 100).toFixed(1)}% on ${shortDate(last.date)}`
      : 'No catalyst priced into the options',
    tone: 'muted',
    section: last ? 'idiosyncratic' : null,
  };
}

/** The six tiles, in reading order: what is happening, what is priced, what the app has learned, what is next. */
export function glanceTiles(input: SummaryInput): GlanceTile[] {
  return [flowTile(input), positioningTile(input), pricingTile(input), moveTile(input), leanTile(input), comingTile(input)];
}

/**
 * The stock in a few short sentences: the flow and the learned lean always,
 * then only what stands out (positioning or option prices outside the stock's
 * own normal) and what is priced ahead.
 */
export function glanceSentence(input: SummaryInput): string {
  const { flow, projection } = input;
  const out: string[] = [];
  const lean = flowLean(flow.putCallRatio);
  if (lean) {
    out.push(
      `Options flow is ${lean}${flow.volumeVsExpected > 0 ? ` on ${flow.volumeVsExpected.toFixed(1)}× its usual volume` : ''}.`,
    );
  }
  const c = flow.conviction;
  out.push(c?.direction ? `The learned lean is ${c.direction} (${points(c.score)} pts).` : 'No learned lean today.');
  const st = standing(flow.analytics?.oiPutCall, flow.ownPc);
  if (st && st !== 'normal') out.push(`Positioning is ${OWN_STANDING_TEXT[st]} for this stock.`);
  if (flow.ivRank !== null && (flow.ivRank >= EXPENSIVE_RANK || flow.ivRank <= CHEAP_RANK)) {
    out.push(
      `Options are ${flow.ivRank >= EXPENSIVE_RANK ? 'expensive' : 'cheap'} by its own standard (IV rank ${flow.ivRank}).`,
    );
  }
  const e = expiryNear(projection, 7);
  if (projection && e) {
    const r = range68(e, flow.livePrice ?? projection.spot);
    if (r.pct !== null) out.push(`Options price about ±${(r.pct * 100).toFixed(1)}% by ${weekdayDate(e.expiration)}.`);
  }
  const g = flow.eventGauge;
  if (g?.eventDate) {
    out.push(
      `${g.eventSource === 'bulge' ? 'A possible catalyst' : 'A catalyst'} is dated ${shortDate(g.eventDate)}${g.impliedMove !== null ? ` (±${(g.impliedMove * 100).toFixed(1)}% priced)` : ''}.`,
    );
  }
  return out.join(' ');
}
