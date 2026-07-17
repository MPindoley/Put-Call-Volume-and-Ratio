/**
 * Socket.io server bootstrap. Attached to the custom HTTP server in server.ts;
 * pushes flow/ratio/alert/status events produced by the poller + flow engine.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { getFlowEngine } from './flow-engine';
import type { ClientToServerEvents, ServerToClientEvents } from '@/types';

export type FlowSocketServer = Server<ClientToServerEvents, ServerToClientEvents>;

export function createSocketServer(httpServer: HttpServer): FlowSocketServer {
  const io: FlowSocketServer = new Server(httpServer, {
    path: '/api/socket',
    cors: { origin: true, credentials: true },
    // Socket.io handles transport fallback (websocket → polling) natively.
    transports: ['websocket', 'polling'],
  });

  const engine = getFlowEngine();

  // Spike alerts push the moment they fire, independent of the poll cadence.
  engine.onAlert((alert) => io.emit('spike-alert', alert));

  io.on('connection', (socket) => {
    // New client: send full current state so the table renders instantly.
    socket.emit('flow-update', engine.allFlows());
    const aggregate = engine.getAggregate();
    const series = engine.getRatioSeries();
    const lastPoint = series[series.length - 1];
    if (aggregate && lastPoint) {
      socket.emit('ratio-update', aggregate, engine.getSectors(), lastPoint);
    }
    socket.emit('connection-status', engine.status());

    socket.on('request-snapshot', () => {
      socket.emit('flow-update', engine.allFlows());
    });
  });

  return io;
}
