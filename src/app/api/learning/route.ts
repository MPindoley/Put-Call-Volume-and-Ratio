import { NextResponse } from 'next/server';
import { getAnalyticsConfig } from '@/lib/analytics-config';
import { tryDb } from '@/lib/db';
import { summarizeBook, LEARNING_PARAMS } from '@/lib/learning';
import { bookFromRow, currentLearningVersion } from '@/lib/learning-data';

export const dynamic = 'force-dynamic';

/**
 * What the app has learned: the latest edge book under the current learning
 * version, summarised at the signal and signal·regime levels. Edges are hit-rate
 * points above the regime-matched base rate (+0.05 = hits 5 points more often
 * than no-skill), shrunk toward zero in proportion to their evidence.
 *
 * `learning: null` means no book exists yet (nothing graded under this version).
 */
export async function GET(): Promise<NextResponse> {
  const cfg = await getAnalyticsConfig();
  const version = currentLearningVersion(cfg);
  const data = await tryDb('learning summary', async (db) => {
    const latest = await db.edgeBook.findFirst({ where: { version }, orderBy: { asOf: 'desc' } });
    const books = await db.edgeBook.count({ where: { version } });
    if (!latest) return { version, books, learning: null };
    return {
      version,
      books,
      learning: {
        asOf: latest.asOf.toISOString().slice(0, 10),
        reconstructed: latest.reconstructed,
        rowsUsed: latest.rowsUsed,
        rowsUnbased: latest.rowsUnbased,
        params: LEARNING_PARAMS,
        signals: summarizeBook(bookFromRow(latest)),
      },
    };
  });
  if (data === null) return NextResponse.json({ error: 'database unavailable' }, { status: 503 });
  return NextResponse.json(data);
}
