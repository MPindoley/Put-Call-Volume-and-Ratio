import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { getPolygonClient } from '@/lib/polygon';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const engine = getFlowEngine();
  const status = {
    ...engine.status(),
    apiCallsLastMinute: getPolygonClient().bucket.callsLastMinute(),
  };
  return NextResponse.json(status, { status: status.healthy ? 200 : 503 });
}
