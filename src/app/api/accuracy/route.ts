import { NextResponse } from 'next/server';
import { tryDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface ScoredAlert {
  symbol: string;
  level: string;
  putCallRatio: number;
  moveNextDay: number;
  createdAt: Date;
}

interface LevelStats {
  level: string;
  n: number;
  hitRate: number;
  avgMove: number;
  avgAbsMove: number;
}

/**
 * Alert accuracy scoreboard. Direction logic: a put-heavy alert (P/C > 1) is
 * a "hit" if the underlying fell the next day; call-heavy if it rose.
 */
export async function GET(): Promise<NextResponse> {
  const data = await tryDb('accuracy stats', async (db) => {
    const scored = (await db.alert.findMany({
      where: { moveNextDay: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: { symbol: true, level: true, putCallRatio: true, moveNextDay: true, createdAt: true },
    })) as ScoredAlert[];

    const byLevel = new Map<string, ScoredAlert[]>();
    for (const a of scored) {
      const list = byLevel.get(a.level) ?? [];
      list.push(a);
      byLevel.set(a.level, list);
    }

    const isHit = (a: ScoredAlert): boolean =>
      a.putCallRatio > 1 ? a.moveNextDay < 0 : a.moveNextDay > 0;

    const levels: LevelStats[] = [...byLevel.entries()].map(([level, list]) => ({
      level,
      n: list.length,
      hitRate: Math.round((list.filter(isHit).length / list.length) * 100),
      avgMove: Number((list.reduce((s, a) => s + a.moveNextDay, 0) / list.length).toFixed(2)),
      avgAbsMove: Number((list.reduce((s, a) => s + Math.abs(a.moveNextDay), 0) / list.length).toFixed(2)),
    }));

    return {
      totalScored: scored.length,
      overallHitRate:
        scored.length > 0 ? Math.round((scored.filter(isHit).length / scored.length) * 100) : null,
      levels: levels.sort((a, b) => b.n - a.n),
      recent: scored.slice(0, 20).map((a) => ({
        symbol: a.symbol,
        level: a.level,
        direction: a.putCallRatio > 1 ? 'bearish' : 'bullish',
        moveNextDay: a.moveNextDay,
        hit: isHit(a),
        createdAt: a.createdAt.getTime(),
      })),
    };
  });

  if (!data) {
    return NextResponse.json({ totalScored: 0, overallHitRate: null, levels: [], recent: [], dbRequired: true });
  }
  return NextResponse.json(data);
}
