import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { tryDb } from '@/lib/db';
import { loadTrackRecord } from '@/lib/learning-data';
import { tickerCoverage } from '@/lib/projection-jobs';
import { TRACKED_UNIVERSE } from '@/lib/universe';

export const dynamic = 'force-dynamic';

const HISTORY_ROWS = 100;

interface Params {
  params: { symbol: string };
}

/** Live row + stored 5-min history + the name's learning track record (detail page). */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const symbol = params.symbol.toUpperCase();
  const engine = getFlowEngine();
  const flow = engine.getFlow(symbol);
  if (!flow) {
    // Tracked but not fetched yet (quieter names load over ~half an hour after a
    // restart, refresh-schedule.ts) is not the same as untracked — say which.
    const pending = TRACKED_UNIVERSE.some((u) => u.symbol === symbol);
    return NextResponse.json(
      { error: pending ? `${symbol} has no snapshot yet` : `unknown or untracked ticker: ${symbol}`, pending },
      { status: 404 },
    );
  }
  const [history, trackRecord, projectionCoverage] = await Promise.all([
    tryDb('ticker history', (db) =>
      // The page shows the latest 100 buckets and refetches every 15 s: read
      // just those, not 30 days of rows only to discard most of them.
      db.flowSnapshot.findMany({
        where: { symbol, bucketStart: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { bucketStart: 'desc' },
        take: HISTORY_ROWS,
        select: {
          bucketStart: true,
          putVolume: true,
          callVolume: true,
          putCallRatio: true,
          spikeScore: true,
        },
      }),
    ),
    tryDb('ticker track record', (db) => loadTrackRecord(db, symbol)),
    tickerCoverage(symbol),
  ]);
  const coverage = engine.projectionCoverage;
  return NextResponse.json({
    flow,
    history: (history ?? []).reverse(),
    trackRecord,
    // Market-implied projection + how such projections have held up.
    projection: engine.projections.get(symbol) ?? null,
    calibration: engine.calibrations.get(symbol) ?? null,
    projectionCoverage: {
      ticker: projectionCoverage,
      sector: coverage?.bySector.get(flow.sector) ?? null,
      all: coverage?.all ?? null,
    },
  });
}
