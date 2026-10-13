import { NextResponse } from 'next/server';
import { getLearningReport } from '@/lib/learning-jobs';

export const dynamic = 'force-dynamic';

/**
 * The learning page's data: how much the app knows (status), whether its data
 * is healthy, and whether its learned convictions have actually been right
 * (self-grading, replayed point-in-time). Cached ~30 min, keyed to the latest
 * nightly book.
 */
export async function GET(): Promise<NextResponse> {
  const report = await getLearningReport();
  if (report === null) {
    return NextResponse.json({ error: 'database unavailable or no sessions captured yet' }, { status: 503 });
  }
  return NextResponse.json(report);
}
