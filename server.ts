/**
 * Custom server: Next.js + Socket.io + the polling service in one process,
 * sharing the in-memory FlowEngine. This is what runs on Railway (or any
 * long-lived Node host). `npm run dev` runs the same thing with HMR.
 *
 * If you split frontend (Vercel) from backend, run `npm run worker` on the
 * backend host instead and point NEXT_PUBLIC_SOCKET_URL at it.
 */
import { createServer } from 'node:http';
import next from 'next';
import { Poller } from './src/lib/poller';
import { createSocketServer } from './src/lib/websocket';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const app = next({ dev });
  await app.prepare();
  const handle = app.getRequestHandler();

  const httpServer = createServer((req, res) => void handle(req, res));
  const io = createSocketServer(httpServer);

  const poller = new Poller(io);
  poller.start();

  httpServer.listen(port, () => {
    console.log(`▲ options-flow-dashboard ready on http://localhost:${port} (${dev ? 'dev' : 'production'})`);
  });

  const shutdown = (): void => {
    console.log('shutting down…');
    poller.stop();
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
