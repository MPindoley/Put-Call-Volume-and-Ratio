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
    // Compress frames over 1 KB. Flow rows are repetitive JSON (the same keys
    // on every row), so a full-table frame shrinks several-fold — fewer bytes
    // out of the host (the metered direction) and faster loads on a phone.
    perMessageDeflate: { threshold: 1024 },
  });

  const engine = getFlowEngine();

  // Spike alerts push the moment they fire, independent of the poll cadence.
  engine.onAlert((alert) => io.emit('spike-alert', alert));

  io.on('connection', (socket) => {
    // The client asks for the full table itself ('request-snapshot', sent on
    // every connect and reconnect), so it is not pushed here as well — that
    // sent the whole table twice per connection.
    const aggregate = engine.getAggregate();
    const series = engine.getRatioSeries();
    const lastPoint = series[series.length - 1];
    if (aggregate && lastPoint) {
      socket.emit('ratio-update', aggregate, engine.getSectors(), lastPoint, engine.marketContext, engine.getSectorDispersions());
    }
    socket.emit('connection-status', engine.status());

    socket.on('request-snapshot', () => {
      socket.emit('flow-update', engine.allFlows());
    });
  });

  return io;
}
