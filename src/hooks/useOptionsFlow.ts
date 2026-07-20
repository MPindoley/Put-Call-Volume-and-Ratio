'use client';

/**
 * Server-state hydration via React Query: one initial fetch of the full flow
 * snapshot, plus polling fallback that activates only while the socket is
 * down (stale-while-revalidate degradation, not duplicate traffic).
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useFlowStore } from '@/store/flowStore';
import type {
  AggregateRatio,
  ConnectionStatus,
  MarketContext,
  RatioPoint,
  SectorRatio,
  TickerFlow,
} from '@/types';

interface FlowResponse {
  rows: TickerFlow[];
  aggregate: AggregateRatio | null;
  market: MarketContext | null;
  sectors: SectorRatio[];
  ratioSeries: RatioPoint[];
  status: ConnectionStatus;
}

async function fetchFlow(): Promise<FlowResponse> {
  const res = await fetch('/api/flow');
  if (!res.ok) throw new Error(`flow fetch failed: ${res.status}`);
  return (await res.json()) as FlowResponse;
}

export function useOptionsFlow(): { isLoading: boolean; isError: boolean } {
  const socketConnected = useFlowStore((s) => s.socketConnected);
  const hydrate = useFlowStore((s) => s.hydrate);

  const query = useQuery({
    queryKey: ['flow'],
    queryFn: fetchFlow,
    // Poll over HTTP only while the socket is down.
    refetchInterval: socketConnected ? false : 15_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data) hydrate(query.data);
  }, [query.data, hydrate]);

  return { isLoading: query.isLoading, isError: query.isError };
}
