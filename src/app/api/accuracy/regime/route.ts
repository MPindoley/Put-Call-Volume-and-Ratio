import { NextResponse } from 'next/server';
import { buildRegimeMatrixData, type Basis, type Horizon, type RegimeMatrixData } from '@/lib/matrix-data';
import { assertSeedAllowed } from '@/lib/seed-guard';
import { buildMatrix, type MatrixRow } from '@/lib/signals';

export const dynamic = 'force-dynamic';

/**
 * Deterministic synthetic payload for previewing the populated grid during
 * development. Guarded by the SAME production gate as the seed scripts
 * (assertSeedAllowed): impossible with NODE_ENV=production, and requires
 * ALLOW_SEED=1 — not merely unused. Every payload is stamped demo:true.
 */
function demoPayload(horizon: Horizon, basis: Basis): RegimeMatrixData & { demo: true } {
  const rows: MatrixRow[] = [];
  const mk = (
    signalType: string,
    direction: 'bullish' | 'bearish',
    cell: [string, string, string | null],
    n: number,
    hits: number,
    base: number,
  ): void => {
    for (let i = 0; i < n; i++) {
      rows.push({
        signalType,
        direction,
        regimeVol: cell[0],
        regimeTrend: cell[1],
        regimeGamma: cell[2],
        ret: (i < hits) === (direction === 'bullish') ? 0.012 : -0.008,
        baseHitProb: base,
        baseSource: i % 5 === 0 ? 'cohort' : 'ticker',
      });
    }
  };
  mk('skew_z', 'bullish', ['pos', 'pos', 'pos'], 42, 27, 0.54);
  mk('skew_z', 'bullish', ['neg', 'neg', 'na'], 24, 11, 0.47);
  mk('pc_extreme', 'bearish', ['pos', 'pos', 'pos'], 35, 20, 0.49);
  mk('pc_extreme', 'bearish', ['neg', 'pos', 'neg'], 12, 8, 0.52); // suppressed (<20)
  mk('divergence', 'bearish', ['pos', 'pos', 'na'], 22, 13, 0.5);
  mk('spike_alert', 'bullish', ['pos', 'pos', 'pos'], 28, 15, 0.55);
  return {
    demo: true,
    warming: false,
    signalsLogged: 240,
    signalsScored: 163,
    firstScoringDate: null,
    horizon,
    basis,
    matrix: buildMatrix(rows, 20),
    excludedByVersion: 3,
    thresholdVersion: 'demo0000',
    regimeConfigVersion: 'demo0000',
    fullTripleFrom: '2026-07-23',
    eventTrack: { n: 14, hits: 9, hitRate: 9 / 14, undershootBase: 0.61, wilson: { lo: 0.388, hi: 0.837 } },
    backwardation: [
      { resolution: 'front_collapse', n: 9, avgCumReturnPct: -0.8, outcomes: { iv_crush: 6, faded: 3 }, methods: { components: 7, proxy: 2 } },
      { resolution: 'back_lift', n: 4, avgCumReturnPct: -4.1, outcomes: { realized_move: 3, faded: 1 }, methods: { components: 4 } },
    ],
    backwardationOpen: 5,
    regimeDetachLogged: 11,
    etfTrack: [
      { signalType: 'pc_extreme', n: 31, hits: 14, hitRate: 14 / 31, avgRet: -0.001 },
      { signalType: 'skew_z', n: 9, hits: 5, hitRate: 5 / 9, avgRet: 0.002 },
    ],
  };
}

/**
 * Regime-conditional accuracy matrix (Phase 4.4). EXPLORATORY: overlapping
 * forward-return windows are autocorrelated and a many-cell matrix will produce
 * some impressive numbers by chance — the payload carries cellsTested,
 * expectedByChance and per-cell Wilson CIs so the UI can say so out loud.
 *
 * Query: ?horizon=5|10|20 (default 10) · ?basis=exSpy|exSector|raw (default
 * exSpy — hit is defined on the EXCESS return; raw is the explicit toggle) ·
 * ?format=csv for the flat export.
 */
export async function GET(req: Request): Promise<NextResponse | Response> {
  const url = new URL(req.url);
  const h = Number(url.searchParams.get('horizon') ?? 10);
  const horizon: Horizon = h === 5 || h === 20 ? h : 10;
  const b = url.searchParams.get('basis');
  const basis: Basis = b === 'raw' || b === 'exSector' ? b : 'exSpy';

  if (url.searchParams.get('demo') === '1') {
    try {
      assertSeedAllowed('regime matrix demo'); // throws in production / without ALLOW_SEED=1
    } catch {
      return NextResponse.json({ error: 'demo mode is disabled in production' }, { status: 403 });
    }
    return NextResponse.json(demoPayload(horizon, basis));
  }

  const data = await buildRegimeMatrixData(horizon, basis);
  if (!data) {
    return NextResponse.json({ warming: true, signalsLogged: 0, signalsScored: 0, dbRequired: true });
  }

  if (url.searchParams.get('format') === 'csv') {
    const rows: string[] = [
      'signal_type,regime_vol,regime_trend,regime_gamma,n,hits,hit_rate,base_rate,excess_over_base,avg_fwd_return,wilson_lo,wilson_hi,base_source,suppressed',
    ];
    for (const c of data.matrix?.cells ?? []) {
      rows.push(
        [
          c.signalType,
          c.regimeVol,
          c.regimeTrend,
          c.regimeGamma,
          c.n,
          c.hits,
          c.hitRate.toFixed(4),
          c.baseRate?.toFixed(4) ?? '',
          c.excess?.toFixed(4) ?? '',
          c.avgRet.toFixed(5),
          c.wilson?.lo.toFixed(4) ?? '',
          c.wilson?.hi.toFixed(4) ?? '',
          c.baseSource ?? '',
          c.suppressed,
        ].join(','),
      );
    }
    rows.push('');
    rows.push(`# horizon=${horizon}td basis=${basis} thresholdVersion=${data.thresholdVersion} regimeConfigVersion=${data.regimeConfigVersion}`);
    rows.push(`# cellsTested=${data.matrix?.cellsTested ?? 0} expectedByChance=${data.matrix?.expectedByChance ?? 0} excludedByVersion=${data.excludedByVersion}`);
    rows.push('# EXPLORATORY: overlapping windows are autocorrelated; some cells clear thresholds by chance.');
    return new Response(rows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="regime-matrix-${horizon}td-${basis}.csv"`,
      },
    });
  }

  // Strip statistics from suppressed cells (n stays visible for warming coverage).
  const payload = {
    ...data,
    matrix: data.matrix
      ? {
          ...data.matrix,
          cells: data.matrix.cells.map((c) =>
            c.suppressed
              ? { ...c, hitRate: null, baseRate: null, excess: null, avgRet: null, wilson: null }
              : c,
          ),
        }
      : null,
  };
  return NextResponse.json(payload);
}
