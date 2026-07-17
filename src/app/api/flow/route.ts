import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/** Full live state: rows + aggregate + sectors + ratio series + status. */
export function GET(): NextResponse {
  const engine = getFlowEngine();
  return NextResponse.json({
    rows: engine.allFlows(),
    aggregate: engine.getAggregate(),
    sectors: engine.getSectors(),
    ratioSeries: engine.getRatioSeries(),
    status: engine.status(),
  });
}
