/**
 * Prisma client with graceful degradation: if DATABASE_URL is unset or the
 * database is unreachable, every persistence call becomes a no-op and the
 * dashboard keeps serving live in-memory data (history features disabled).
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient | null };

/**
 * Connection defaults for a small hosted database, each applied only when the
 * URL does not set it:
 *  - connect_timeout=30: a database that scales to zero (Neon's free tier) can
 *    take longer than Prisma's default 5 s to wake, and the first query after
 *    an idle spell would otherwise fail;
 *  - connection_limit=5: Prisma's default pool is 2 × CPUs + 1, which on a
 *    large host exceeds a free plan's cap (Aiven's is 20, shared with the
 *    pre-deploy step and the outgoing deploy). One server needs few.
 */
export function withConnectionDefaults(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', '30');
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '5');
    return u.toString();
  } catch {
    return raw;
  }
}

function createClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL) return null;
  try {
    return new PrismaClient({
      log: ['warn', 'error'],
      datasources: { db: { url: withConnectionDefaults(process.env.DATABASE_URL) } },
    });
  } catch (err) {
    console.error('[db] failed to initialize Prisma client, running without persistence:', err);
    return null;
  }
}

export const prisma: PrismaClient | null =
  globalForPrisma.prisma !== undefined ? globalForPrisma.prisma : (globalForPrisma.prisma = createClient());

export function dbAvailable(): boolean {
  return prisma !== null;
}

/** Run a persistence operation best-effort; log and continue on failure. */
export async function tryDb<T>(label: string, fn: (db: PrismaClient) => Promise<T>): Promise<T | null> {
  if (!prisma) return null;
  try {
    return await fn(prisma);
  } catch (err) {
    console.error(`[db] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}
