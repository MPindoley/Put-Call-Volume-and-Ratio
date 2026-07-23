/* One-command purge of all synthetic seeded rows. Safe in any environment
 * (it only ever DELETES seeded=true rows, never real data).
 * Run: DATABASE_URL=… npx tsx scripts/purge-seed.ts   (or: npm run seed:purge) */
import { prisma } from '../src/lib/db';

async function main(): Promise<void> {
  const db = prisma;
  if (!db) throw new Error('no DATABASE_URL');
  const daily = await db.dailyMetric.deleteMany({ where: { seeded: true } });
  const rel = await db.relativeMetric.deleteMany({ where: { seeded: true } });
  const cohort = await db.cohortDaily.deleteMany({ where: { seeded: true } });
  const events = await db.earningsEvent.deleteMany({ where: { seeded: true } });
  const idio = await db.idiosyncraticEvent.deleteMany({ where: { seeded: true } });
  const regime = await db.dailyRegime.deleteMany({ where: { seeded: true } });
  const signals = await db.signalLog.deleteMany({ where: { seeded: true } });
  const episodes = await db.backwardationEpisode.deleteMany({ where: { seeded: true } });
  console.log(
    `[purge-seed] deleted seeded rows — DailyMetric: ${daily.count}, RelativeMetric: ${rel.count}, ` +
      `CohortDaily: ${cohort.count}, EarningsEvent: ${events.count}, IdiosyncraticEvent: ${idio.count}, ` +
      `DailyRegime: ${regime.count}, SignalLog: ${signals.count}, BackwardationEpisode: ${episodes.count}`,
  );
  await db.$disconnect();
  process.exit(0);
}

void main();
