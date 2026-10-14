import { NextResponse } from 'next/server';
import { getSchwabAuth } from '@/lib/schwab-auth';

export const dynamic = 'force-dynamic';

/** Forget the Schwab tokens; the dashboard falls back to the delayed feed. */
export async function POST(): Promise<NextResponse> {
  await getSchwabAuth()?.disconnect();
  return NextResponse.json({ ok: true });
}
