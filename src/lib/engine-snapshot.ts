/**
 * Save and restore the live engine's state across restarts.
 *
 * The scanner table lives in memory (flow-engine.ts). Without this, every
 * deploy or crash started from an empty table: during market hours it took
 * about half an hour to rebuild, and after the close — when polling idles to
 * save money — it stayed empty until the next open. Worse, the pinned
 * end-of-day capture reads that table, so a restart just after the close
 * captured nothing for the day.
 *
 * Now the poller saves every row and projection (gzip-compressed JSON, one
 * database row) every few minutes while the market is open, once at the
 * close, and after an after-hours catch-up pass; a restart restores it before
 * anything else runs. Rows keep their own data times, so their age is shown
 * honestly. Live (non-simulated) data only.
 */
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { AggregateRatio, DataSourceMode, MarketContext, RatioPoint, SectorRatio, TickerFlow } from '@/types';
import { tryDb } from './db';
import type { FlowEngine } from './flow-engine';
import type { Projection } from './projection';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Bump when the payload shape changes; an older snapshot is ignored, not misread. */
export const SNAPSHOT_VERSION = 1;
/** Minimum spacing of routine saves while polling. */
export const SNAPSHOT_EVERY_MS = 10 * 60_000;

export interface EngineSnapshotPayload {
  v: number;
  mode: DataSourceMode;
  savedAt: number;
  flows: TickerFlow[];
  projections: Projection[];
  aggregate: AggregateRatio | null;
  sectors: SectorRatio[];
  ratioSeries: RatioPoint[];
  marketContext: MarketContext | null;
}

export function snapshotPayload(engine: FlowEngine, now = Date.now()): EngineSnapshotPayload {
  return {
    v: SNAPSHOT_VERSION,
    mode: engine.mode,
    savedAt: now,
    flows: engine.allFlows().filter((f) => f.lastUpdated > 0),
    projections: [...engine.projections.values()],
    aggregate: engine.getAggregate(),
    sectors: engine.getSectors(),
    ratioSeries: engine.getRatioSeries(),
    marketContext: engine.marketContext,
  };
}

export async function encodeSnapshot(p: EngineSnapshotPayload): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(p)));
}

/** Null when the bytes are not a snapshot this version can read. */
export async function decodeSnapshot(bytes: Uint8Array): Promise<EngineSnapshotPayload | null> {
  try {
    const p = JSON.parse((await gunzipAsync(Buffer.from(bytes))).toString('utf8')) as EngineSnapshotPayload;
    return p && p.v === SNAPSHOT_VERSION && Array.isArray(p.flows) ? p : null;
  } catch {
    return null;
  }
}

/** Save the engine's rows; skipped for simulated data or an empty table (never overwrite a good save with nothing). */
export async function saveEngineSnapshot(engine: FlowEngine, reason: string): Promise<boolean> {
  if (engine.mode !== 'live') return false;
  const p = snapshotPayload(engine);
  if (p.flows.length === 0) return false;
  const payload = await encodeSnapshot(p);
  const ok = await tryDb('save engine snapshot', async (db) => {
    const data = { savedAt: new Date(p.savedAt), version: SNAPSHOT_VERSION, rows: p.flows.length, payload };
    await db.engineSnapshot.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    return true;
  });
  if (ok) console.log(`[snapshot] saved ${p.flows.length} rows (${(payload.length / 1024).toFixed(0)} KB, ${reason})`);
  return ok ?? false;
}

/** Restore the last saved rows into an engine; returns how many were restored. */
export async function restoreEngineSnapshot(engine: FlowEngine): Promise<number> {
  if (engine.mode !== 'live') return 0;
  const row = await tryDb('load engine snapshot', (db) => db.engineSnapshot.findUnique({ where: { id: 1 } }));
  if (!row) return 0;
  const p = await decodeSnapshot(row.payload);
  if (!p || p.mode !== 'live') {
    console.warn('[snapshot] saved snapshot unreadable or from another version — starting empty');
    return 0;
  }
  const restored = engine.restoreSnapshot(p);
  const newest = engine.latestDataAsOf();
  console.log(
    `[snapshot] restored ${restored} rows saved ${new Date(p.savedAt).toISOString()}` +
      (newest > 0 ? `, data as of ${new Date(newest).toISOString()}` : ''),
  );
  return restored;
}
