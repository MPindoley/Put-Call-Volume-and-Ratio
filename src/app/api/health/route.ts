import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const status = getFlowEngine().status();
  return NextResponse.json(status, { status: status.healthy ? 200 : 503 });
}
