/* One-time repair for review finding L2-1.
 *
 * Signals scored BEFORE the L2-1 fix may carry a forward-return endpoint measured
 * against a PROVISIONAL close (a live intraday price), and because SignalLog rows
 * are immutable once scored they can never self-correct. This resets every scored
 * row back to unscored (clearing the forward-return + realizedMove fields) and
 * re-runs scoreSignals, which
 * now reads finalized closes only — so every endpoint becomes an official close.
 *
 * This is NOT a retroactive recompute-with-new-definitions (which the immutability
 * invariant forbids): it corrects rows written by a now-fixed defect. The regime
 * triple, direction, magnitude and all version stamps on each row are left
 * untouched — only the outcome fields are recomputed from the same fire-time data.
 *
 * Run once against the deployed DB after deploying the L2-1 / liveClose fix:
 *   DATABASE_URL=… npx tsx scripts/rescore-signals.ts
 *   DATABASE_URL=… DRY_RUN=1 npx tsx scripts/rescore-signals.ts   (report only)
 */
import { prisma } from '../src/lib/db';
import { scoreSignals } from '../src/lib/signal-jobs';

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');

  // Query (f): how many signals are currently scored?
  const scoredBefore = await db.signalLog.count({ where: { scored: true, seeded: false } });
  const total = await db.signalLog.count({ where: { seeded: false } });
  console.log(`SignalLog: ${total} rows, ${scoredBefore} scored.`);

  if (scoredBefore === 0) {
    console.log('Nothing scored yet — no rows can carry a provisional-close return. No repair needed.');
    await db.$disconnect();
    process.exit(0);
  }

  if (process.env.DRY_RUN === '1') {
    console.log(`DRY_RUN: would reset ${scoredBefore} scored rows and re-score against finalized closes.`);
    await db.$disconnect();
    process.exit(0);
  }

  // Reset outcome fields only; fire-time facts (regime, direction, magnitude, versions) untouched.
  const reset = await db.signalLog.updateMany({
    where: { scored: true, seeded: false },
    data: {
      scored: false,
      fwd5Raw: null, fwd10Raw: null, fwd20Raw: null,
      fwd5ExSpy: null, fwd10ExSpy: null, fwd20ExSpy: null,
      fwd5ExSector: null, fwd10ExSector: null, fwd20ExSector: null,
      realizedMove: null,
    },
  });
  console.log(`Reset ${reset.count} rows to unscored.`);

  const rescored = await scoreSignals();
  const scoredAfter = await db.signalLog.count({ where: { scored: true, seeded: false } });
  console.log(`Re-scored ${rescored}; now ${scoredAfter} scored (against finalized closes only).`);
  console.log(
    scoredAfter < scoredBefore
      ? `Note: ${scoredBefore - scoredAfter} rows are no longer scoreable — their 20-td window was measured only via a provisional close that no longer exists; they will score once the finalized endpoint lands.`
      : 'All previously-scored rows re-scored.',
  );

  await db.$disconnect();
  process.exit(0);
}

void main();
