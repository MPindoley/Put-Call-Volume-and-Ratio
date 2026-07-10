'use client';

/**
 * Socket.io client wiring. Connects once, funnels every server event into the
 * flow store, and exposes connection state. Socket.io handles reconnection
 * with exponential backoff natively; useOptionsFlow adds HTTP polling as a
 * degraded-mode fallback whenever this reports disconnected.
 */
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useFlowStore } from '@/store/flowStore';
import type { ClientToServerEvents, ServerToClientEvents } from '@/types';

type FlowSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: FlowSocket | null = null;

function getSocket(): FlowSocket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL ?? '';
    socket = io(url, {
      path: '/api/socket',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
  }
  return socket;
}

export function useWebSocket(): { connected: boolean } {
  const connected = useFlowStore((s) => s.socketConnected);

  useEffect(() => {
    const s = getSocket();
    const store = useFlowStore.getState();

    const onConnect = (): void => {
      useFlowStore.getState().setSocketConnected(true);
      s.emit('request-snapshot');
    };
    const onDisconnect = (): void => useFlowStore.getState().setSocketConnected(false);

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('flow-update', store.applyFlowUpdate);
    s.on('ratio-update', store.applyRatioUpdate);
    s.on('connection-status', store.applyStatus);
    s.on('spike-alert', store.pushAlert);

    if (s.connected) onConnect();

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('flow-update', store.applyFlowUpdate);
      s.off('ratio-update', store.applyRatioUpdate);
      s.off('connection-status', store.applyStatus);
      s.off('spike-alert', store.pushAlert);
    };
  }, []);

  return { connected };
}
