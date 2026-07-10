/**
 * Prisma client with graceful degradation: if DATABASE_URL is unset or the
 * database is unreachable, every persistence call becomes a no-op and the
 * dashboard keeps serving live in-memory data (history features disabled).
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient | null };

function createClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL) return null;
  try {
    return new PrismaClient({ log: ['warn', 'error'] });
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
