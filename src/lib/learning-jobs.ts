/**
 * Nightly learning job: write the edge book for every finalized session that
 * does not yet have one under the current learning version.
 *
 * On a normal night that is exactly one book — today's — written right after
 * signals are graded (runMaintenance). On first run, or after a version change,
 * it reconstructs books for past sessions too, flagged `reconstructed`. That is
 * safe because each book is point-in-time by construction (learning.ts), and it
 * means self-grading has a history to work with immediately instead of starting
 * from zero.
 *
 * Books are immutable: an existing (asOf, version) row is never rewritten.
 */
import { Prisma } from '@prisma/client';
import { tryDb } from './db';
import { bookAt, convictionsAt, loadLearningInputs, serializeConvictions } from './learning-data';

/** Upper bound on books reconstructed in one run (one trading year). */
const MAX_BACKFILL_BOOKS = 252;

export interface RefreshResult {
  version: string;
  written: number;
  reconstructed: number;
  latestAsOf: string | null;
}

export async function refreshEdgeBooks(): Promise<RefreshResult | null> {
  return tryDb('refresh edge books', async (db) => {
    const inputs = await loadLearningInputs(db);
    if (!inputs) return null;
    const { sessions, version } = inputs;
    const lastIdx = sessions.length - 1;

    // Nothing to learn before the first outcome is knowable.
    const firstKnown = inputs.evidence.reduce((m, e) => Math.min(m, e.knownIdx), Infinity);
    const start = Math.max(Number.isFinite(firstKnown) ? firstKnown : lastIdx, lastIdx - MAX_BACKFILL_BOOKS + 1);

    const existing = await db.edgeBook.findMany({
      where: { version, asOf: { gte: new Date(`${sessions[Math.max(0, start)]}T00:00:00Z`) } },
      select: { asOf: true },
    });
    const have = new Set(existing.map((b) => b.asOf.toISOString().slice(0, 10)));

    let written = 0;
    let reconstructed = 0;
    for (let a = Math.max(0, start); a <= lastIdx; a++) {
      if (have.has(sessions[a]!)) continue;
      const book = bookAt(inputs, a);
      const isReconstruction = a < lastIdx;
      try {
        await db.edgeBook.create({
          data: {
            asOf: new Date(`${sessions[a]}T00:00:00Z`),
            version,
            rowsUsed: book.rowsUsed,
            rowsUnbased: book.rowsUnbased,
            nodes: book.nodes as unknown as Prisma.InputJsonValue,
            convictions: serializeConvictions(convictionsAt(inputs, book, a)) as Prisma.InputJsonValue,
            reconstructed: isReconstruction,
          },
        });
      } catch (err) {
        // A concurrent run already wrote it: immutable, so theirs stands.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
      written += 1;
      if (isReconstruction) reconstructed += 1;
    }
    if (written > 0) console.log(`[learning] wrote ${written} edge book(s) (${reconstructed} reconstructed), version ${version}`);
    return { version, written, reconstructed, latestAsOf: sessions[lastIdx] ?? null };
  });
}
