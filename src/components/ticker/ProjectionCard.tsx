'use client';

/**
 * Projection: the price distribution option prices imply for each expiry
 * (projection.ts), how such ranges have compared with real moves for this
 * stock (projection-history.ts), the open-interest positioning around the
 * price, and the learned signal tilt — each kept separate, so it is always
 * clear which part is market-priced, which is measured history, and which is
 * learned.
 */
import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { Term } from '@/components/ui/term';
import type { ExpiryProjection, Projection } from '@/lib/projection';
import { calibratedPrice, probAboveLevel } from '@/lib/projection';
import type { CalibrationView, Coverage, HorizonKey } from '@/lib/projection-history';
import { cn, formatTime } from '@/lib/utils';
import type { TickerFlow } from '@/types';

export interface ProjectionCoverage {
  ticker: Record<HorizonKey, Coverage> | null;
  sector: Record<HorizonKey, Coverage> | null;
  all: Record<HorizonKey, Coverage> | null;
}

const money = (v: number): string => `$${v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2)}`;
const pct = (v: number | null, digits = 0): string => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
/** Odds never read as certain or impossible when they are merely tiny. */
const odds = (v: number): string => (v > 0 && v < 0.005 ? '<1%' : v < 1 && v > 0.995 ? '>99%' : pct(v));
const signedPct = (v: number, digits = 1): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
const dateLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const horizonFor = (e: ExpiryProjection): HorizonKey => (e.dte <= 15 ? 'week' : 'month');

/** Default to the expiry nearest a month out. */
function defaultIndex(expiries: ExpiryProjection[]): number {
  let best = 0;
  expiries.forEach((e, i) => {
    if (Math.abs(e.dte - 30) < Math.abs(expiries[best]!.dte - 30)) best = i;
  });
  return best;
}

export function ProjectionCard({
  flow,
  projection,
  calibration,
  coverage,
}: {
  flow: TickerFlow;
  projection: Projection | null;
  calibration: Record<HorizonKey, CalibrationView> | null;
  coverage: ProjectionCoverage;
}): JSX.Element {
  const [picked, setPicked] = useState<number | null>(null);

  if (!projection || projection.expiries.length === 0) {
    return (
      <Card>
        <CardHeader title="Projection" />
        <p className="px-4 py-6 text-xs leading-relaxed text-slate-500">
          No projection yet — it is computed from this stock&apos;s full option chain (every strike and expiry), which arrives
          with the next refresh of this name. Simulated data has no chain to read.
        </p>
      </Card>
    );
  }

  const idx = Math.min(picked ?? defaultIndex(projection.expiries), projection.expiries.length - 1);
  const e = projection.expiries[idx]!;
  const [q025, q16, q50, q84, q975] = e.quantiles as [number, number, number, number, number];
  const spot = flow.livePrice ?? projection.spot;
  const horizon = horizonFor(e);
  const cal = calibration?.[horizon] ?? null;

  return (
    <Card>
      <CardHeader
        title="Projection — where option prices put the stock"
        right={
          <span className="text-[10px] text-slate-500">
            <Term k="projection">market-implied</Term> · chain {formatTime(projection.dataAsOf)} ET
          </span>
        }
      />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Expiry">
          {projection.expiries.map((x, i) => (
            <button
              key={x.expiration}
              role="tab"
              aria-selected={i === idx}
              onClick={() => setPicked(i)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[11px] tnum',
                i === idx
                  ? 'border-blue-500 bg-blue-500/10 text-slate-100'
                  : 'border-surface-border text-slate-400 hover:text-slate-200',
              )}
            >
              {dateLabel(x.expiration)} <span className="text-slate-500">· {Math.round(x.dte)}d</span>
            </button>
          ))}
        </div>

        <div>
          <p className="text-sm leading-relaxed text-slate-200">
            By <span className="font-semibold text-slate-100">{dateLabel(e.expiration)}</span> ({Math.round(e.dte)} days), option
            prices put a <Term k="range68">68% chance</Term> on {flow.symbol} closing between{' '}
            <span className="font-semibold tnum text-slate-100">{money(q16)}</span> and{' '}
            <span className="font-semibold tnum text-slate-100">{money(q84)}</span>, and <Term k="range95">95%</Term> between{' '}
            <span className="tnum">{money(q025)}</span> and <span className="tnum">{money(q975)}</span>.
          </p>
          <p className="mt-1 text-[11px] tnum text-slate-500">
            <Term k="medianPrice">Middle</Term> {money(q50)} · <Term k="forward">Forward</Term> {money(e.forward)} · one standard
            deviation ±{(e.sigmaMove * 100).toFixed(1)}% · ATM <Term k="iv30">IV</Term> {e.atmIv.toFixed(1)} ·{' '}
            <Term k="smileMethod">{e.method === 'smile' ? 'skew-aware' : 'flat (few quotes)'}</Term>
          </p>
        </div>

        <RangeBar e={e} spot={spot} projection={projection} cal={cal} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Cone projection={projection} spot={spot} selected={idx} />
          <OddsTable e={e} spot={spot} projection={projection} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <HistoryCheck e={e} cal={cal} horizon={horizon} />
          <TrackRecord coverage={coverage} horizon={horizon} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <PositioningBlock projection={projection} spot={spot} />
          <TiltBlock flow={flow} />
        </div>

        <p className="text-[10px] leading-relaxed text-slate-600">
          Mathematics on traded option prices, not a forecast: these are the market&apos;s risk-neutral odds, which include what
          traders pay for protection and so usually overstate how far stocks really move. The history check measures that gap for
          this stock; every week&apos;s ranges are logged and graded at expiry.
        </p>
      </div>
    </Card>
  );
}

/** One horizontal price axis: 95% and 68% bands, the middle, today's price, walls and the gamma flip. */
function RangeBar({
  e,
  spot,
  projection,
  cal,
}: {
  e: ExpiryProjection;
  spot: number;
  projection: Projection;
  cal: CalibrationView | null;
}): JSX.Element {
  const [q025, q16, q50, q84, q975] = e.quantiles as [number, number, number, number, number];
  const { callWall, putWall, gammaFlip } = projection.positioning;
  const lo = Math.min(q025, spot) * 0.985;
  const hi = Math.max(q975, spot) * 1.015;
  const x = (v: number): string => `${(((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100).toFixed(2)}%`;
  const inView = (v: number | null): v is number => v !== null && v > lo && v < hi;
  const adj = cal?.usable
    ? {
        lo: calibratedPrice(q16, e.forward, cal.ratio),
        hi: calibratedPrice(q84, e.forward, cal.ratio),
      }
    : null;
  const markers = [
    inView(putWall) ? { v: putWall, label: 'Put wall', cls: 'bg-bullish' } : null,
    inView(callWall) ? { v: callWall, label: 'Call wall', cls: 'bg-bearish' } : null,
    inView(gammaFlip) ? { v: gammaFlip, label: 'Gamma flip', cls: 'bg-caution' } : null,
  ].filter((m): m is { v: number; label: string; cls: string } => m !== null);
  // Close levels would print on top of each other: alternate their labels between two rows.
  const pos = (v: number): number => (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  const rows = markers
    .sort((a, b) => a.v - b.v)
    .reduce<number[]>((acc, m, i, all) => [...acc, i > 0 && pos(m.v) - pos(all[i - 1]!.v) < 0.22 && acc[i - 1] === 0 ? 1 : 0], []);

  return (
    <div className="pt-5">
      <div className="relative h-7 rounded bg-surface" aria-label="Implied price range">
        <div
          className="absolute inset-y-1 rounded bg-blue-500/15"
          style={{ left: x(q025), width: `calc(${x(q975)} - ${x(q025)})` }}
        />
        <div
          className="absolute inset-y-0 rounded bg-blue-500/35"
          style={{ left: x(q16), width: `calc(${x(q84)} - ${x(q16)})` }}
        />
        {adj && (
          <div
            className="absolute inset-y-[11px] rounded-full border border-dashed border-slate-300/70"
            style={{
              left: x(adj.lo),
              width: `calc(${x(adj.hi)} - ${x(adj.lo)})`,
            }}
            title={`History-adjusted 68%: ${money(adj.lo)} – ${money(adj.hi)}`}
          />
        )}
        <div className="absolute inset-y-0 w-px bg-blue-200" style={{ left: x(q50) }} title={`Middle ${money(q50)}`} />
        <div className="absolute -top-5 -translate-x-1/2 text-[10px] font-semibold tnum text-slate-100" style={{ left: x(spot) }}>
          {money(spot)}
        </div>
        <div className="absolute -top-1 bottom-[-4px] w-0.5 -translate-x-1/2 bg-slate-100" style={{ left: x(spot) }} />
      </div>
      <div className="relative mt-1 h-4 text-[10px] tnum text-slate-500">
        {[q025, q16, q84, q975].map((v, i) => (
          <span key={i} className="absolute -translate-x-1/2" style={{ left: x(v) }}>
            {money(v)}
          </span>
        ))}
      </div>
      {markers.length > 0 && (
        <div className={cn('relative mt-1', rows.includes(1) ? 'h-12' : 'h-8')}>
          {markers.map((m, i) => (
            <div
              key={m.label}
              className="absolute flex -translate-x-1/2 flex-col items-center"
              style={{ left: x(m.v), top: rows[i] === 1 ? 18 : 0 }}
            >
              <span className={cn('h-2 w-2 rotate-45', m.cls)} />
              <span className="whitespace-nowrap text-[9px] text-slate-400">
                {m.label} {money(m.v)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-slate-500">
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-blue-500/35 align-middle" />
          68% range
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-blue-500/15 align-middle" />
          95% range
        </span>
        {adj && (
          <span>
            <span className="mr-1 inline-block h-2 w-3 rounded-full border border-dashed border-slate-300/70 align-middle" />
            <Term k="adjustedRange">history-adjusted 68%</Term>
          </span>
        )}
        <span>
          <span className="mr-1 inline-block h-3 w-0.5 bg-slate-100 align-middle" />
          price now
        </span>
      </p>
    </div>
  );
}

/** The ranges across every expiry, as a cone from today's price. */
function Cone({ projection, spot, selected }: { projection: Projection; spot: number; selected: number }): JSX.Element {
  const W = 360;
  const H = 170;
  const pad = { l: 8, r: 52, t: 10, b: 20 };
  const ex = projection.expiries;
  const maxD = Math.max(...ex.map((e) => e.dte));
  const lo = Math.min(spot, ...ex.map((e) => e.quantiles[0]!)) * 0.99;
  const hi = Math.max(spot, ...ex.map((e) => e.quantiles[4]!)) * 1.01;
  // √time axis: ranges grow with √t, so the cone reads as straight edges and near expiries get room.
  const px = (d: number): number => pad.l + Math.sqrt(d / maxD) * (W - pad.l - pad.r);
  const py = (v: number): number =>
    pad.t + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (H - pad.t - pad.b);
  const band = (a: number, b: number): string =>
    [
      `${px(0)},${py(spot)}`,
      ...ex.map((e) => `${px(e.dte)},${py(e.quantiles[b]!)}`),
      ...[...ex].reverse().map((e) => `${px(e.dte)},${py(e.quantiles[a]!)}`),
    ].join(' ');
  const mid = [`${px(0)},${py(spot)}`, ...ex.map((e) => `${px(e.dte)},${py(e.quantiles[2]!)}`)].join(' ');
  const sel = ex[selected]!;
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-[460px]"
        role="img"
        aria-label="Implied price cone across expiries"
      >
        <polygon points={band(0, 4)} className="fill-blue-500/15" />
        <polygon points={band(1, 3)} className="fill-blue-500/35" />
        <polyline points={mid} className="fill-none stroke-blue-200" strokeWidth={1} />
        <line
          x1={px(0)}
          x2={W - pad.r}
          y1={py(spot)}
          y2={py(spot)}
          className="stroke-slate-400"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
        <line x1={px(sel.dte)} x2={px(sel.dte)} y1={pad.t} y2={H - pad.b} className="stroke-blue-500" strokeWidth={1} />
        {[sel.quantiles[1]!, sel.quantiles[3]!, sel.quantiles[0]!, sel.quantiles[4]!]
          // The 68% bounds first; drop any label within 10px of one already kept (or of the price).
          .reduce<number[]>((kept, v) => (kept.every((k) => Math.abs(py(k) - py(v)) >= 10) ? [...kept, v] : kept), [spot])
          .slice(1)
          .map((v, i) => (
            <text key={i} x={W - pad.r + 4} y={py(v) + 3} className="fill-slate-400 text-[9px] tnum">
              {money(v)}
            </text>
          ))}
        <text x={W - pad.r + 4} y={py(spot) + 3} className="fill-slate-100 text-[9px] font-semibold tnum">
          {money(spot)}
        </text>
        {ex
          .filter((e, i) => i === 0 || px(e.dte) - px(ex[i - 1]!.dte) >= 22)
          .map((e) => (
            <text key={e.expiration} x={px(e.dte)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[9px] tnum">
              {Math.round(e.dte)}d
            </text>
          ))}
      </svg>
      <figcaption className="text-[10px] text-slate-500">
        Ranges widen with time; the blue line marks the selected expiry.
      </figcaption>
    </figure>
  );
}

function OddsTable({ e, spot, projection }: { e: ExpiryProjection; spot: number; projection: Projection }): JSX.Element {
  const { callWall, putWall, gammaFlip } = projection.positioning;
  const levels: { label: string; v: number }[] = [
    { label: '−10%', v: spot * 0.9 },
    { label: '−5%', v: spot * 0.95 },
    { label: 'Price now', v: spot },
    { label: '+5%', v: spot * 1.05 },
    { label: '+10%', v: spot * 1.1 },
  ];
  if (callWall) levels.push({ label: 'Call wall', v: callWall });
  if (putWall) levels.push({ label: 'Put wall', v: putWall });
  if (gammaFlip) levels.push({ label: 'Gamma flip', v: gammaFlip });
  levels.sort((a, b) => b.v - a.v);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[300px] text-[11px] tnum">
        <caption className="mb-1 text-left text-[10px] uppercase tracking-wider text-slate-500">
          Odds by {dateLabel(e.expiration)}
        </caption>
        <thead className="text-left text-[10px] text-slate-500">
          <tr>
            <th className="py-1 font-normal">Level</th>
            <th className="py-1 text-right font-normal">Price</th>
            <th className="py-1 text-right font-normal">
              <Term k="probAbove">Close above</Term>
            </th>
            <th className="py-1 text-right font-normal">Close below</th>
            <th className="py-1 text-right font-normal">
              <Term k="probTouch">Touch ≈</Term>
            </th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => {
            const above = probAboveLevel(e, l.v);
            const beyond = l.v >= spot ? above : 1 - above;
            const touch = l.label === 'Price now' ? null : Math.min(1, 2 * beyond);
            return (
              <tr
                key={l.label}
                className={cn('border-t border-surface-border/50', l.label === 'Price now' ? 'text-slate-100' : 'text-slate-300')}
              >
                <td className="py-1">{l.label}</td>
                <td className="py-1 text-right">{money(l.v)}</td>
                <td className="py-1 text-right">{odds(above)}</td>
                <td className="py-1 text-right">{odds(1 - above)}</td>
                <td className="py-1 text-right text-slate-500">{touch === null ? '' : odds(touch)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryCheck({
  e,
  cal,
  horizon,
}: {
  e: ExpiryProjection;
  cal: CalibrationView | null;
  horizon: HorizonKey;
}): JSX.Element {
  const span = horizon === 'week' ? '5-session (~1 week)' : '21-session (~1 month)';
  const [, q16, , q84] = e.quantiles as [number, number, number, number, number];
  return (
    <div className="rounded-md border border-surface-border bg-surface p-3 text-[11px] leading-relaxed text-slate-400">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">History check — real moves vs priced</p>
      {!cal || (!cal.usable && cal.ticker.n === 0) ? (
        <p>
          Warming up: this needs stored daily IV and closes for at least 3 independent {span} periods. It starts filling in as the
          database captures sessions.
        </p>
      ) : (
        <>
          <p>
            Over {span} windows, this stock&apos;s real moves were{' '}
            <span className="font-semibold tnum text-slate-200">
              {cal.ticker.ratio !== null ? `${cal.ticker.ratio.toFixed(2)}×` : '—'}
            </span>{' '}
            the size options priced (<Term k="calibrationRatio">realized ÷ implied</Term>), landing inside the priced 68% range{' '}
            <span className="tnum text-slate-200">{pct(cal.ticker.inside68)}</span> of the time (a fair price: 68%) —{' '}
            {cal.ticker.periods} independent periods.
          </p>
          <p className="mt-1">
            Sector: {cal.sector.ratio !== null ? `${cal.sector.ratio.toFixed(2)}×` : '—'}, inside 68% {pct(cal.sector.inside68)} (
            {cal.sector.periods} periods). Blended estimate used:{' '}
            <span className="font-semibold tnum text-slate-200">{cal.ratio.toFixed(2)}×</span> ({pct(cal.tickerWeight)} from this
            stock).
          </p>
          {cal.usable ? (
            <p className="mt-1 text-slate-300">
              <Term k="adjustedRange">History-adjusted 68% range</Term>:{' '}
              <span className="font-semibold tnum">
                {money(calibratedPrice(q16, e.forward, cal.ratio))} – {money(calibratedPrice(q84, e.forward, cal.ratio))}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-slate-500">Too few independent periods yet to adjust the range.</p>
          )}
        </>
      )}
    </div>
  );
}

function TrackRecord({ coverage, horizon }: { coverage: ProjectionCoverage; horizon: HorizonKey }): JSX.Element {
  const rows: { label: string; c: Coverage | null }[] = [
    { label: 'This stock', c: coverage.ticker?.[horizon] ?? null },
    { label: 'Sector', c: coverage.sector?.[horizon] ?? null },
    { label: 'All names', c: coverage.all?.[horizon] ?? null },
  ];
  const any = rows.some((r) => (r.c?.n ?? 0) > 0);
  return (
    <div className="rounded-md border border-surface-border bg-surface p-3 text-[11px] text-slate-400">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Term k="coverage">Track record</Term> — {horizon === 'week' ? '~1-week' : '~1-month'} ranges, graded at expiry
      </p>
      {!any ? (
        <p className="leading-relaxed">
          No graded projections yet. Ranges are logged once a week at the end-of-day capture and graded with the settled close on
          their expiry date, so the first grades land about {horizon === 'week' ? 'a week' : 'a month'} after logging begins.
        </p>
      ) : (
        <table className="w-full tnum">
          <thead className="text-left text-[10px] text-slate-500">
            <tr>
              <th className="py-0.5 font-normal" />
              <th className="py-0.5 text-right font-normal">Graded</th>
              <th className="py-0.5 text-right font-normal">In 68%</th>
              <th className="py-0.5 text-right font-normal">In 95%</th>
              <th className="py-0.5 text-right font-normal">Missed low / high</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, c }) => (
              <tr key={label} className="border-t border-surface-border/50 text-slate-300">
                <td className="py-0.5">{label}</td>
                <td className="py-0.5 text-right">{c?.n ?? 0}</td>
                <td className="py-0.5 text-right">{pct(c?.inside68 ?? null)}</td>
                <td className="py-0.5 text-right">{pct(c?.inside95 ?? null)}</td>
                <td className="py-0.5 text-right text-slate-500">
                  {pct(c?.below68 ?? null)} / {pct(c?.above68 ?? null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PositioningBlock({ projection, spot }: { projection: Projection; spot: number }): JSX.Element {
  const { callWall, putWall, gammaFlip, gammaAtSpot } = projection.positioning;
  const rel = (v: number | null): string => (v === null ? '' : ` (${signedPct(v / spot - 1)})`);
  return (
    <div className="rounded-md border border-surface-border bg-surface p-3 text-[11px] text-slate-400">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Positioning around the price</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tnum">
        <dt>
          <Term k="callWall" />
        </dt>
        <dd className="text-slate-200">{callWall !== null ? `${money(callWall)}${rel(callWall)}` : '—'}</dd>
        <dt>
          <Term k="putWall" />
        </dt>
        <dd className="text-slate-200">{putWall !== null ? `${money(putWall)}${rel(putWall)}` : '—'}</dd>
        <dt>
          <Term k="gammaFlip" />
        </dt>
        <dd className="text-slate-200">{gammaFlip !== null ? `${money(gammaFlip)}${rel(gammaFlip)}` : 'none within ±20%'}</dd>
      </dl>
      {gammaAtSpot && (
        <p className="mt-1.5 leading-relaxed">
          Estimated dealer gamma at today&apos;s price is{' '}
          <span className={gammaAtSpot === 'positive' ? 'text-bullish' : 'text-bearish'}>{gammaAtSpot}</span>:{' '}
          {gammaAtSpot === 'positive' ? 'hedging tends to steady the stock.' : 'hedging tends to amplify moves.'}
        </p>
      )}
    </div>
  );
}

function TiltBlock({ flow }: { flow: TickerFlow }): JSX.Element {
  const c = flow.conviction;
  return (
    <div className="rounded-md border border-surface-border bg-surface p-3 text-[11px] leading-relaxed text-slate-400">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Term k="tilt">Signal tilt</Term> — which way, from the learned record
      </p>
      {c?.direction ? (
        <>
          <p>
            Today&apos;s signals lean{' '}
            <span className={cn('font-semibold', c.direction === 'bullish' ? 'text-bullish' : 'text-bearish')}>
              {c.direction}
            </span>
            : historically{' '}
            <span className="font-semibold tnum text-slate-200">
              {c.score >= 0 ? '+' : ''}
              {(c.score * 100).toFixed(1)} points
            </span>{' '}
            more likely than the <Term k="baseRate">base rate</Term> to {c.direction === 'bullish' ? 'beat' : 'trail'} SPY over 10
            sessions.
          </p>
          <ul className="mt-1 space-y-0.5 tnum">
            {c.parts.map((p) => (
              <li key={`${p.signalType}|${p.direction}`}>
                {p.signalType.replace('_', ' ')} {p.direction} · <Term k="learnedEdge">edge</Term> {(p.edge * 100).toFixed(1)} pts
                · {p.n} graded
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          No measurable lean from today&apos;s signals. The range above is how far the market prices the stock to move; direction
          comes only from signals with a record behind them.
        </p>
      )}
      <a href="#track-record" className="mt-1 inline-block text-blue-400 hover:underline">
        How it was learned →
      </a>
    </div>
  );
}
