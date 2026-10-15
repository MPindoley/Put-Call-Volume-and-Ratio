/**
 * One-time import of the history in an older database (IMPORT_DATABASE_URL)
 * into the current one (DATABASE_URL) — for a move between hosts, e.g. Neon to
 * Aiven, made while the old database was locked.
 *
 * The current database has already been collecting, so the two overlap. Rules:
 *  - By default the CURRENT row wins: every table is copied with skip-on-
 *    conflict on its natural key (symbol + date, bucket, …), and surrogate ids
 *    are left for the current database to assign.
 *  - Except where the current row is a weaker stand-in for the same fact:
 *    a close-only backfill (DailyMetric.historicalCloseOnly) gives way to the
 *    old database's captured row (IV, skew, OI, …), and a backfilled regime
 *    row (no gamma) gives way to the old database's captured one.
 *  - Edge books are derived: the current database's were built from a few
 *    days of history, so they are dropped, the old ones copied, and the
 *    missing recent ones rebuilt by the next maintenance pass from the merged
 *    evidence (reconstructed: true).
 *  - Not copied: the saved scanner table (the current one is newer) and the
 *    volume baselines (rebuilt from the copied snapshots).
 *
 * The import retries on every attempt until it completes (the old database may
 * be unreachable — Neon locks a free project that used its monthly hours until
 * the next month), then records itself in DataImport and never runs again for
 * that source. Copying is idempotent, so an attempt that fails part-way is
 * simply repeated.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { invalidateAnalyticsConfig } from './analytics-config';
import { prisma, withConnectionDefaults } from './db';

const PAGE = 1_000;
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args: unknown): Promise<Row[]>;
  createMany(args: unknown): Promise<{ count: number }>;
  deleteMany(args?: unknown): Promise<{ count: number }>;
}

interface TableSpec {
  /** Prisma model (delegate) name. */
  model: string;
  /** Unique, sortable field to page by. */
  cursor: string;
  /** Autoincrement id: let the current database assign its own. */
  dropId: boolean;
  /** Only rows the current retention would keep. */
  where?: (now: Date) => Row;
  /** Before a page is inserted: remove current rows that page should replace. */
  replace?: (target: PrismaClient, page: Row[]) => Promise<number>;
  /** Before the table is copied: remove current rows that are wholly derived. */
  clearFirst?: boolean;
}

/** Captured daily rows replace close-only backfills of the same day. */
async function replaceCloseOnly(target: PrismaClient, page: Row[]): Promise<number> {
  const captured = page.filter((r) => r.final === true && r.historicalCloseOnly === false && r.seeded === false);
  if (captured.length === 0) return 0;
  const keys = captured.map((r) => Prisma.sql`(${r.symbol as string}, ${r.date as Date} AT TIME ZONE 'UTC')`);
  return target.$executeRaw`
    DELETE FROM "DailyMetric"
    WHERE "historicalCloseOnly" AND ("symbol", "date") IN (VALUES ${Prisma.join(keys)})
  `;
}

/** Captured regime rows (with gamma) replace backfilled ones (without) of the same day. */
async function replaceGammaless(target: PrismaClient, page: Row[]): Promise<number> {
  const captured = page.filter((r) => r.gammaState !== null && r.seeded === false);
  if (captured.length === 0) return 0;
  const dates = captured.map((r) => Prisma.sql`(${r.date as Date} AT TIME ZONE 'UTC')`);
  return target.$executeRaw`
    DELETE FROM "DailyRegime"
    WHERE "gammaState" IS NULL AND "date" IN (VALUES ${Prisma.join(dates)})
  `;
}

/** In dependency order: tickers before everything that references them. */
export const IMPORT_TABLES: TableSpec[] = [
  { model: 'ticker', cursor: 'symbol', dropId: false },
  { model: 'sectorBenchmark', cursor: 'sector', dropId: false },
  { model: 'marketCapConfig', cursor: 'symbol', dropId: false },
  { model: 'analyticsConfig', cursor: 'id', dropId: false },
  { model: 'userSettings', cursor: 'id', dropId: false },
  { model: 'tickerOverride', cursor: 'symbol', dropId: false },
  { model: 'brokerToken', cursor: 'provider', dropId: false },
  { model: 'edgarCache', cursor: 'key', dropId: false },
  { model: 'dailyMetric', cursor: 'id', dropId: true, replace: replaceCloseOnly },
  { model: 'relativeMetric', cursor: 'id', dropId: true },
  { model: 'cohortDaily', cursor: 'id', dropId: true },
  { model: 'earningsEvent', cursor: 'id', dropId: true },
  { model: 'idiosyncraticEvent', cursor: 'id', dropId: true },
  { model: 'backwardationEpisode', cursor: 'id', dropId: true },
  { model: 'dailyRegime', cursor: 'id', dropId: true, replace: replaceGammaless },
  { model: 'signalLog', cursor: 'id', dropId: true },
  { model: 'projectionLog', cursor: 'id', dropId: true },
  { model: 'edgeBook', cursor: 'id', dropId: true, clearFirst: true },
  {
    model: 'flowSnapshot',
    cursor: 'id',
    dropId: true,
    where: (now) => ({ bucketStart: { gte: new Date(now.getTime() - 35 * DAY_MS) } }),
  },
  {
    model: 'aggregateRatioPoint',
    cursor: 'id',
    dropId: true,
    where: (now) => ({ bucketStart: { gte: new Date(now.getTime() - 90 * DAY_MS) } }),
  },
  {
    model: 'alert',
    cursor: 'id',
    dropId: false,
    where: (now) => ({ createdAt: { gte: new Date(now.getTime() - 120 * DAY_MS) } }),
  },
];

export interface TableResult {
  model: string;
  read: number;
  added: number;
  replaced: number;
}

function delegate(client: PrismaClient, model: string): Delegate {
  return (client as unknown as Record<string, Delegate>)[model]!;
}

/** Copy every table from `source` into `target` (rules above). Throws on any failure. */
export async function importDatabase(
  source: PrismaClient,
  target: PrismaClient,
  opts: { now?: Date; log?: (line: string) => void } = {},
): Promise<TableResult[]> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line: string) => console.log(`[import] ${line}`));
  const results: TableResult[] = [];
  for (const spec of IMPORT_TABLES) {
    const from = delegate(source, spec.model);
    const to = delegate(target, spec.model);
    if (spec.clearFirst) await to.deleteMany({});
    const result: TableResult = { model: spec.model, read: 0, added: 0, replaced: 0 };
    let after: unknown = undefined;
    for (;;) {
      const page = await from.findMany({
        where: { ...(spec.where?.(now) ?? {}), ...(after !== undefined ? { [spec.cursor]: { gt: after } } : {}) },
        orderBy: { [spec.cursor]: 'asc' },
        take: PAGE,
      });
      if (page.length === 0) break;
      after = page[page.length - 1]![spec.cursor];
      result.read += page.length;
      if (spec.replace) result.replaced += await spec.replace(target, page);
      const data = spec.dropId ? page.map(({ id: _id, ...rest }) => rest) : page;
      result.added += (await to.createMany({ data, skipDuplicates: true })).count;
    }
    if (result.read > 0) {
      log(
        `${spec.model}: ${result.read} rows read, ${result.added} added` +
          (result.replaced > 0 ? ` (${result.replaced} weaker rows replaced)` : '') +
          (result.read > result.added ? `, ${result.read - result.added} already here` : ''),
      );
    }
    results.push(result);
  }
  return results;
}

/** Host + database name: identifies a database without its credentials. */
export function databaseIdentity(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return null;
  }
}

let importing = false;
let lastFailure = '';

/** True while an import is copying (maintenance waits for it). */
export function importInProgress(): boolean {
  return importing;
}

/**
 * Import IMPORT_DATABASE_URL into the current database if it has not been done
 * yet. Returns true when an import completed on this call. Never throws.
 */
export async function maybeImportOldDatabase(): Promise<boolean> {
  const raw = process.env.IMPORT_DATABASE_URL;
  if (!raw || !prisma || importing) return false;
  const source = databaseIdentity(raw);
  if (!source) {
    console.warn('[import] IMPORT_DATABASE_URL is not a valid database URL — ignored');
    return false;
  }
  if (source === databaseIdentity(process.env.DATABASE_URL ?? '')) {
    console.warn('[import] IMPORT_DATABASE_URL is the current database — nothing to import');
    return false;
  }
  const target = prisma;
  importing = true;
  let client: PrismaClient | null = null;
  try {
    if (await target.dataImport.findUnique({ where: { source } })) return false; // done before
    const url = new URL(withConnectionDefaults(raw));
    url.searchParams.set('connection_limit', '2');
    client = new PrismaClient({ log: [], datasources: { db: { url: url.toString() } } });
    try {
      await client.$queryRaw`SELECT 1`;
    } catch (err) {
      // Prisma's message opens with "Invalid `…` invocation:"; the reason follows.
      const lines = (err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim());
      const why = lines.find((l) => l && !l.startsWith('Invalid `')) ?? 'unreachable';
      // Once per distinct reason, not every hour.
      if (why !== lastFailure) console.log(`[import] old database not reachable yet — will retry hourly (${why})`);
      lastFailure = why;
      return false;
    }
    console.log(`[import] copying history from ${source} …`);
    const started = Date.now();
    const results = await importDatabase(client, target);
    const added = results.reduce((s, r) => s + r.added, 0);
    await target.dataImport.create({ data: { source, rows: added } });
    invalidateAnalyticsConfig(); // the copied config, if any, applies from now on
    console.log(
      `[import] done: ${added} rows added in ${Math.round((Date.now() - started) / 1000)} s — IMPORT_DATABASE_URL can now be removed`,
    );
    return true;
  } catch (err) {
    console.error('[import] failed part-way (will retry; copying is idempotent):', err instanceof Error ? err.message : err);
    return false;
  } finally {
    importing = false;
    await client?.$disconnect().catch(() => undefined);
  }
}
