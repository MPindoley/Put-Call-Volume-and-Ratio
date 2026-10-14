import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/** How logged projections have held up (all names and by sector), from the nightly refresh. */
export function GET(): NextResponse {
  const c = getFlowEngine().projectionCoverage;
  return NextResponse.json({
    all: c?.all ?? null,
    bySector: c ? Object.fromEntries([...c.bySector].sort(([a], [b]) => a.localeCompare(b))) : {},
  });
}
