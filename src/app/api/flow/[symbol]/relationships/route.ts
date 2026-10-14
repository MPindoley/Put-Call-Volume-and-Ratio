import { NextResponse } from 'next/server';
import { loadRelationships } from '@/lib/relationship-jobs';

export const dynamic = 'force-dynamic';

interface Params {
  params: { symbol: string };
}

/** How the stock's options data moves together and ahead of its price, plus historical analogs. */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const report = await loadRelationships(params.symbol.toUpperCase());
  if (!report) return NextResponse.json({ error: 'needs a connected database' }, { status: 503 });
  return NextResponse.json(report);
}
