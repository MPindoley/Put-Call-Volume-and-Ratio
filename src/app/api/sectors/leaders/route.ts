import { NextResponse } from 'next/server';
import { loadSectorLeaders } from '@/lib/sector-leader-jobs';

export const dynamic = 'force-dynamic';

/** Who leads whom: names whose option positioning has shifted before their cohort moved (?cohort=XLK). */
export async function GET(req: Request): Promise<NextResponse> {
  const report = await loadSectorLeaders(new URL(req.url).searchParams.get('cohort'));
  if (!report) return NextResponse.json({ error: 'needs a connected database' }, { status: 503 });
  return NextResponse.json(report);
}
