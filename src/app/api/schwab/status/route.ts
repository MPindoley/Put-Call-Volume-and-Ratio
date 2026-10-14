import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { getSchwabAuth, schwabConfig } from '@/lib/schwab-auth';
import { siteLocked } from '@/lib/session';
import type { SchwabStatusResponse } from '@/types';

export const dynamic = 'force-dynamic';

/** Connection state for the Data sources page. Never includes a token. */
export async function GET(): Promise<NextResponse<SchwabStatusResponse>> {
  const cfg = schwabConfig();
  const auth = getSchwabAuth();
  const s = auth ? await auth.status() : null;
  return NextResponse.json({
    configured: cfg !== null,
    siteLocked: siteLocked(),
    callbackUrl: cfg?.callbackUrl ?? null,
    state: s?.state ?? 'unconfigured',
    authorizedAt: s?.authorizedAt ?? null,
    reconnectBy: s?.reconnectBy ?? null,
    lastError: s?.lastError ?? null,
    persisted: s?.persisted ?? false,
    feed: getFlowEngine().realtimeInfo(),
  });
}
