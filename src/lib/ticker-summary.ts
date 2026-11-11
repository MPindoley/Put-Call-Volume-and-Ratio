/**
 * The stock page in a few words: the headline shown on each drop-down section,
 * so a closed section still says what is inside it. Pure — every string is
 * derived from data the page already has, and a missing input reads as "not
 * yet", never as a number.
 */
import type { TrackRecord } from './learning-data';
import { standing } from './own-normal';
import type { ExpiryProjection, Projection } from './projection';
import type { CalibrationView, HorizonKey } from './projection-history';
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
