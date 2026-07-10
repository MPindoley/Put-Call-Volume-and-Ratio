'use client';

/** Seeds alert history on mount; live alerts arrive via the socket. */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useFlowStore } from '@/store/flowStore';
import type { SpikeAlert } from '@/types';

export function useAlerts(): { alerts: SpikeAlert[]; unread: number; markRead: () => void } {
  const alerts = useFlowStore((s) => s.alerts);
  const unread = useFlowStore((s) => s.unreadAlerts);
  const markRead = useFlowStore((s) => s.markAlertsRead);
  const seedAlerts = useFlowStore((s) => s.seedAlerts);

  const query = useQuery({
    queryKey: ['alerts'],
    queryFn: async (): Promise<SpikeAlert[]> => {
      const res = await fetch('/api/alerts?limit=100');
      if (!res.ok) throw new Error('alerts fetch failed');
      return ((await res.json()) as { alerts: SpikeAlert[] }).alerts;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data && useFlowStore.getState().alerts.length === 0) seedAlerts(query.data);
  }, [query.data, seedAlerts]);

  return { alerts, unread, markRead };
}
