import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

export function GET(req: Request): NextResponse {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  return NextResponse.json({ alerts: getFlowEngine().getAlerts(limit) });
}
