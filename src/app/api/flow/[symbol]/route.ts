import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { tryDb } from '@/lib/db';
import { loadTrackRecord } from '@/lib/learning-data';

export const dynamic = 'force-dynamic';

interface Params {
  params: { symbol: string };
}

/** Live row + stored 5-min history + the name's learning track record (detail page). */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const symbol = params.symbol.toUpperCase();
  const engine = getFlowEngine();
  const flow = engine.getFlow(symbol);
  if (!flow) {
    return NextResponse.json({ error: `unknown or untracked ticker: ${symbol}` }, { status: 404 });
  }
  const [history, trackRecord] = await Promise.all([
    tryDb('ticker history', (db) =>
      db.flowSnapshot.findMany({
        where: { symbol, bucketStart: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { bucketStart: 'asc' },
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
  ]);
  return NextResponse.json({ flow, history: history ?? [], trackRecord });
}
