/**
 * Seed-safety guard. Synthetic test rows (marked `seeded: true`) exist only to
 * exercise the pipeline locally. Two guarantees keep them out of production:
 *
 *  1. `assertSeedAllowed()` throws in production, so no seed script can write
 *     to a deployed database even if pointed at one by mistake.
 *  2. Every aggregation read (median, z-score, rolling window, percentile)
 *     filters on `NOT_SEEDED`, so even if a seeded row somehow existed in a
 *     production DB it could never enter a statistic — defense in depth.
 *
 * The deployed capture path (finalize/poller) always writes the schema default
 * `seeded: false`; it never sets `seeded: true`. Therefore no seeded row can be
 * produced by the running application.
 */

/** Prisma `where` fragment that excludes synthetic rows from any aggregation. */
export const NOT_SEEDED = { seeded: false } as const;

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Call at the top of any script that writes `seeded: true` rows. Throws in
 * production; also refuses unless the caller explicitly opts in via
 * ALLOW_SEED=1, so a stray invocation can't silently write test data.
 */
export function assertSeedAllowed(context = 'seed'): void {
  if (isProductionEnv()) {
    throw new Error(`[seed-guard] refusing to write seeded rows: NODE_ENV=production (${context}).`);
  }
  if (process.env.ALLOW_SEED !== '1') {
    throw new Error(
      `[seed-guard] refusing to write seeded rows without ALLOW_SEED=1 (${context}). ` +
        `This prevents accidental synthetic writes.`,
    );
  }
}
