/**
 * The single shared guard for statistic-feeding DailyMetric reads.
 *
 * DECISIONS invariant #2: only finalized, non-seeded rows feed any statistic. The
 * original code enforced this by hand-writing `final: true, seeded: false` on each
 * query, which is filter-dependent — the next query added can silently forget it
 * (this is exactly how review finding L2-1 arose). Route every statistic-feeding
 * read's `where` through {@link finalizedMetricWhere} instead: it force-sets both
 * flags, and the input type FORBIDS passing `final`/`seeded` (a compile error), so
 * a caller cannot weaken or forget the guard.
 *
 * `close` is additionally structural: provisional rows carry it as null (their
 * live value lives in `liveClose`), so a `close: { not: null }` predicate already
 * excludes provisional rows even without this guard — belt and suspenders.
 *
 * Note: backfill rows are `final: true` (with `historicalCloseOnly: true`), so
 * this keeps real historical closes and only ever removes provisional intraday rows.
 */
import type { Prisma } from '@prisma/client';

/** A DailyMetric where clause that may NOT set `final`/`seeded` — the guard owns them. */
export type StatMetricWhere = Omit<Prisma.DailyMetricWhereInput, 'final' | 'seeded'>;

/** Force-merge the finalized + non-seeded guard into a statistic read's where clause. */
export function finalizedMetricWhere(where: StatMetricWhere = {}): Prisma.DailyMetricWhereInput {
  return { ...where, final: true, seeded: false };
}
