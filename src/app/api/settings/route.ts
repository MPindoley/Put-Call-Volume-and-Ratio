import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { tryDb } from '@/lib/db';
import { DEFAULT_SETTINGS, type AppSettings } from '@/types';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json(getFlowEngine().settings);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Validate + apply settings; persisted to DB when available. */
export async function PUT(req: Request): Promise<NextResponse> {
  let body: Partial<AppSettings>;
  try {
    body = (await req.json()) as Partial<AppSettings>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const engine = getFlowEngine();
  const current = engine.settings;
  const next: AppSettings = {
    sensitivity: clamp(Number(body.sensitivity ?? current.sensitivity) || 1, 0.5, 3),
    minPremium: clamp(Number(body.minPremium ?? current.minPremium) || 0, 0, 1_000_000),
    minContracts: clamp(Math.round(Number(body.minContracts ?? current.minContracts) || 1), 1, 1000),
    updateFrequencySec: [15, 30, 60, 300].includes(Number(body.updateFrequencySec))
      ? Number(body.updateFrequencySec)
      : current.updateFrequencySec,
    soundEnabled: typeof body.soundEnabled === 'boolean' ? body.soundEnabled : current.soundEnabled,
    timezone: typeof body.timezone === 'string' && body.timezone.length > 0 ? body.timezone : current.timezone,
    hiddenColumns: Array.isArray(body.hiddenColumns)
      ? body.hiddenColumns.filter((c): c is string => typeof c === 'string')
      : current.hiddenColumns,
    watchlist: Array.isArray(body.watchlist)
      ? body.watchlist.filter((s): s is string => typeof s === 'string').map((s) => s.toUpperCase()).slice(0, 100)
      : current.watchlist,
    tickerOverrides:
      body.tickerOverrides && typeof body.tickerOverrides === 'object'
        ? body.tickerOverrides
        : current.tickerOverrides,
  };
  engine.settings = next;

  await tryDb('persist settings', (db) =>
    db.userSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...toDbShape(next) },
      update: toDbShape(next),
    }),
  );
  return NextResponse.json(next);
}

export async function DELETE(): Promise<NextResponse> {
  const engine = getFlowEngine();
  engine.settings = { ...DEFAULT_SETTINGS };
  return NextResponse.json(engine.settings);
}

function toDbShape(s: AppSettings): {
  sensitivity: number;
  minPremium: number;
  minContracts: number;
  updateFrequencySec: number;
  soundEnabled: boolean;
  timezone: string;
  hiddenColumns: string[];
  watchlist: string[];
} {
  return {
    sensitivity: s.sensitivity,
    minPremium: s.minPremium,
    minContracts: s.minContracts,
    updateFrequencySec: s.updateFrequencySec,
    soundEnabled: s.soundEnabled,
    timezone: s.timezone,
    hiddenColumns: s.hiddenColumns,
    watchlist: s.watchlist,
  };
}
