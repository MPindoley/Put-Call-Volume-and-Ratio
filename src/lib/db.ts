/**
 * Prisma client with graceful degradation: if DATABASE_URL is unset or the
 * database is unreachable, every persistence call becomes a no-op and the
 * dashboard keeps serving live in-memory data (history features disabled).
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient | null };

/**
 * Allow 30 s to connect unless the URL says otherwise. A database that scales
 * to zero (Neon's free tier) can take longer than Prisma's default 5 s to
 * wake, and the first query after an idle spell would otherwise fail.
 */
export function withConnectTimeout(raw: string, seconds = 30): string {
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', String(seconds));
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
      datasources: { db: { url: withConnectTimeout(process.env.DATABASE_URL) } },
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
