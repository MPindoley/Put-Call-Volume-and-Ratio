'use client';

/**
 * One stock's detail payload: the live row plus stored history, its track
 * record and its projection. Shared by the stock page and the scanner's quick
 * look, so opening the page after a quick look starts from data already loaded.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectionCoverage } from '@/components/ticker/ProjectionCard';
import type { TrackRecord } from '@/lib/learning-data';
import type { Projection } from '@/lib/projection';
import type { CalibrationView, HorizonKey } from '@/lib/projection-history';
import type { TickerFlow } from '@/types';

export interface HistoryPoint {
  bucketStart: string;
  putVolume: number;
  callVolume: number;
  putCallRatio: number;
  spikeScore: number;
}

export interface DetailResponse {
  flow: TickerFlow;
  history: HistoryPoint[];
  trackRecord: TrackRecord | null;
  projection: Projection | null;
  calibration: Record<HorizonKey, CalibrationView> | null;
  projectionCoverage: ProjectionCoverage;
}

/** The error's message says why: 'not-tracked', 'pending' (tracked, first snapshot not in yet) or 'fetch-failed'. */
export function useTickerDetail(symbol: string | null): UseQueryResult<DetailResponse, Error> {
  return useQuery({
    queryKey: ['ticker', symbol],
    queryFn: async (): Promise<DetailResponse> => {
      const res = await fetch(`/api/flow/${symbol}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { pending?: boolean } | null;
        throw new Error(res.status === 404 ? (body?.pending ? 'pending' : 'not-tracked') : 'fetch-failed');
      }
      return (await res.json()) as DetailResponse;
    },
    enabled: symbol !== null,
    refetchInterval: 15_000,
    retry: 1,
  });
}
