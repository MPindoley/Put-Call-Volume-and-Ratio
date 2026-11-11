/**
 * The Learning page in a few words: the sentence and tiles at the top, and the
 * headline on each drop-down section. Pure, like ticker-summary.ts — each
 * string is derived from what the page has already loaded, and anything not
 * loaded or not yet learned says so instead of showing a number.
 */
import type { GlossaryKey } from './glossary';
import type { SignalSummary } from './learning';
import type { CoverageReport } from './learning-coverage';
import type { LearningReport } from './learning-jobs';
import type { Coverage, HorizonKey } from './projection-history';
import { shortDate, type Tone } from './ticker-summary';

export const SIGNAL_NAMES: Record<string, string> = {
  skew_z: 'Skew z-score',
  divergence: 'Price / skew divergence',
  pc_extreme: 'OI put/call extreme',
  pc_own: 'OI put/call vs own range',
  spike_alert: 'Volume spike',
};

export type LearningSectionId = 'signals' | 'together' | 'self-grade' | 'time-of-day' | 'projection' | 'coverage' | 'health';

export interface LearningSummaryInput {
  report: LearningReport | null;
  /** Signal-level estimates from the latest book; null until one exists. */
  signals: SignalSummary[] | null;
  /** Pairs of signals seen together; null until built. */
  combos: { pairs: { verdict: 'stronger' | 'weaker' | 'same' | 'learning' }[] } | null;
  coverage: CoverageReport | null;
  intraday: { clock: { names: number; withOwnData: number }; spikes: { episodes: number; pending: number } } | null;
  /** The projection's graded ranges across all names. */
  projection: Record<HorizonKey, Coverage> | null;
}

const pts = (x: number | null): string => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`);
const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`);
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "Aug 3 – Nov 10", with the years only when the span crosses one. */
export function dateSpan(first: string, last: string): string {
  const y1 = first.slice(0, 4);
  const y2 = last.slice(0, 4);
  return y1 === y2 ? `${shortDate(first)} – ${shortDate(last)}` : `${shortDate(first)} ${y1} – ${shortDate(last)} ${y2}`;
}

/** Stocks with at least one problem (a stock can appear under several kinds). */
export function flaggedStocks(coverage: CoverageReport | null): number {
  return coverage ? new Set(coverage.attention.flatMap((g) => g.stocks.map((s) => s.symbol))).size : 0;
}

function signalsHeadline({ signals }: LearningSummaryInput): string {
  if (!signals || signals.length === 0) return 'Nothing graded yet';
  const best = signals.reduce((a, b) => (b.edge > a.edge ? b : a));
  const name = `${SIGNAL_NAMES[best.signalType] ?? best.signalType} ${best.direction}`;
  return `${count(signals.length, 'signal')} tracked · strongest: ${name} ${pts(best.edge)} pts`;
}

function togetherHeadline({ combos }: LearningSummaryInput): string {
  if (!combos) return 'Built with the next nightly run';
  if (combos.pairs.length === 0) return 'No two signals have fired together yet';
  const n = (v: string): number => combos.pairs.filter((p) => p.verdict === v).length;
  const parts = [`${count(combos.pairs.length, 'pair')} seen together`];
  if (n('stronger') > 0) parts.push(`${n('stronger')} stronger together`);
  if (n('weaker') > 0) parts.push(`${n('weaker')} weaker together`);
  if (n('learning') > 0) parts.push(`${n('learning')} still learning`);
  return parts.join(' · ');
}

function selfGradeHeadline({ report }: LearningSummaryInput): string {
  const c = report?.selfGrade;
  if (!c || c.n === 0) return 'No graded calls yet';
  return `Right ${pct(c.hitRate)} of the time vs ${pct(c.base)} on an ordinary day · ${pts(c.realized)} pts delivered vs ${pts(c.predicted)} claimed`;
}

function timeOfDayHeadline({ intraday }: LearningSummaryInput): string {
  if (!intraday) return 'When stocks trade through the day · what followed spike alerts';
  return `${intraday.clock.withOwnData.toLocaleString('en-US')} of ${intraday.clock.names.toLocaleString('en-US')} stocks have sessions of their own · ${count(intraday.spikes.episodes, 'spike alert')} graded`;
}

function projectionHeadline({ projection }: LearningSummaryInput): string {
  if (!projection || projection.week.n + projection.month.n === 0) return 'No graded projections yet';
  const part = (label: string, c: Coverage): string =>
    `${label} 68% ranges held ${pct(c.inside68)} (${c.n.toLocaleString('en-US')} graded)`;
  return [
    projection.week.n > 0 ? part('1-week', projection.week) : null,
    projection.month.n > 0 ? part('1-month', projection.month) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
}

function coverageHeadline({ coverage }: LearningSummaryInput): string {
  if (!coverage) return 'Whether each stock’s data is reaching the learning';
  const flagged = flaggedStocks(coverage);
  const sessions = `${count(coverage.sessions.captured, 'session')} captured`;
  return flagged === 0
    ? `Every stock is reaching every stage · ${sessions}`
    : `${count(flagged, 'stock')} need${flagged === 1 ? 's' : ''} attention · ${sessions}`;
}

function healthHeadline({ report }: LearningSummaryInput): string {
  if (!report) return 'What was left out of the learning, and why';
  const s = report.status;
  const left = s.signals.unbased + s.signals.excludedFrozen;
  const frozen = s.frozen.names > 0 ? `${count(s.frozen.names, 'stock')} with frozen prices` : 'no frozen prices found';
  return `${left === 0 ? 'No signals left out' : `${count(left, 'signal')} left out`} · ${frozen}`;
}

/** One line per section, keyed by section id. */
export function learningHeadlines(input: LearningSummaryInput): Record<LearningSectionId, string> {
  return {
    signals: signalsHeadline(input),
    together: togetherHeadline(input),
    'self-grade': selfGradeHeadline(input),
    'time-of-day': timeOfDayHeadline(input),
    projection: projectionHeadline(input),
    coverage: coverageHeadline(input),
    health: healthHeadline(input),
  };
}

export interface LearningTile {
  id: 'grade' | 'graded' | 'pending' | 'established' | 'captured' | 'snapshots';
  label: string;
  term: GlossaryKey;
  verdict: string;
  detail: string;
  tone: Tone;
  section: LearningSectionId | null;
}

/** The six tiles: is it working, how much evidence, how much is still coming, how much data. */
export function learningTiles({ report }: LearningSummaryInput): LearningTile[] {
  if (!report) return [];
  const s = report.status;
  const c = report.selfGrade;
  const est = s.established;
  const estN = est ? est.signal.established + est.regime.established + est.sector.established + est.ticker.established : 0;
  const estT = est ? est.signal.total + est.regime.total + est.sector.total + est.ticker.total : 0;
  return [
    {
      id: 'grade',
      label: 'Is it working?',
      term: 'learnSelfGrade',
      verdict: c.n === 0 || c.realized === null ? 'Too early to say' : `${pts(c.realized)} pts delivered`,
      detail:
        c.n === 0 || c.realized === null
          ? 'Its calls are graded 10 sessions after they are shown'
          : `claimed ${pts(c.predicted)} · ${count(c.n, 'graded call')}`,
      tone: c.n === 0 || c.realized === null ? 'muted' : c.realized > 0 ? 'bullish' : 'bearish',
      section: 'self-grade',
    },
    {
      id: 'graded',
      label: 'Signals graded',
      term: 'learnGraded',
      verdict: s.signals.graded.toLocaleString('en-US'),
      detail: `of ${s.signals.logged.toLocaleString('en-US')} logged`,
      tone: 'neutral',
      section: 'signals',
    },
    {
      id: 'pending',
      label: 'Awaiting grades',
      term: 'learnPending',
      verdict: s.signals.pending.toLocaleString('en-US'),
      detail: s.signals.nextMaturity ? `next due ${shortDate(s.signals.nextMaturity)}` : 'none pending',
      tone: 'neutral',
      section: 'signals',
    },
    {
      id: 'established',
      label: 'Established estimates',
      term: 'learnEstablished',
      verdict: `${estN.toLocaleString('en-US')} / ${estT.toLocaleString('en-US')}`,
      detail: 'earned at least half their own weight',
      tone: 'neutral',
      section: 'signals',
    },
    {
      id: 'captured',
      label: 'Sessions captured',
      term: 'learnCaptured',
      verdict: String(s.captured.count),
      detail: s.captured.first && s.captured.last ? dateSpan(s.captured.first, s.captured.last) : 'first at the next close',
      tone: 'neutral',
      section: 'coverage',
    },
    {
      id: 'snapshots',
      label: 'Nightly snapshots',
      term: 'learnSnapshots',
      verdict: String(s.books.total),
      detail: `${s.books.live} live · ${s.books.reconstructed} rebuilt`,
      tone: 'neutral',
      section: null,
    },
  ];
}

/** The state of the learning in a few short sentences. */
export function learningSentence(input: LearningSummaryInput): string {
  const { report, coverage } = input;
  if (!report) return '';
  const c = report.selfGrade;
  const out: string[] = [];
  if (c.n > 0 && c.realized !== null) {
    out.push(
      `Over ${count(c.n, 'graded call')}, the app’s leans were right ${pct(c.hitRate)} of the time against ${pct(c.base)} on an ordinary day: ${pts(c.realized)} points delivered, ${pts(c.predicted)} claimed.`,
    );
  } else {
    out.push('None of the app’s own calls has been graded yet — that starts 10 sessions after the first lean is shown.');
  }
  const s = report.status.signals;
  out.push(`${count(s.graded, 'signal')} graded so far, ${s.pending.toLocaleString('en-US')} waiting for their window to close.`);
  const flagged = flaggedStocks(coverage);
  if (flagged > 0) out.push(`${count(flagged, 'stock')} need${flagged === 1 ? 's' : ''} attention on data coverage.`);
  return out.join(' ');
}
