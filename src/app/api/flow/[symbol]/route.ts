import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { tryDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Params {
  params: { symbol: string };
}

/** Live row + stored 5-min history for one ticker (detail page). */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const symbol = params.symbol.toUpperCase();
  const engine = getFlowEngine();
  const flow = engine.getFlow(symbol);
  if (!flow) {
    return NextResponse.json({ error: `unknown or untracked ticker: ${symbol}` }, { status: 404 });
  }
  const history = await tryDb('ticker history', (db) =>
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
  );
  return NextResponse.json({ flow, history: history ?? [] });
}
