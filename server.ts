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
import { saveEngineSnapshot } from './src/lib/engine-snapshot';
import { getFlowEngine } from './src/lib/flow-engine';
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

  // Open the port BEFORE any polling starts. The first chain cycle parses
  // multi-MB JSON (SPY alone is ~6 MB) and res.json() blocks the event loop
  // while it does, at concurrency 10. Doing that before the port is listening
  // — or while the platform is issuing its first healthcheck — starves the
  // probe, and the container gets SIGTERM'd as a failed deploy.
  httpServer.listen(port, () => {
    console.log(`▲ options-flow-dashboard ready on http://localhost:${port} (${dev ? 'dev' : 'production'})`);
    poller.start();
  });

  const shutdown = (): void => {
    console.log('shutting down…');
    poller.stop();
    io.close();
    // Best effort: save the table so the next process starts with it (the
    // poller also saves every few minutes, so a hard kill loses little).
    const saved = Promise.race([
      saveEngineSnapshot(getFlowEngine(), 'shutdown').catch(() => false),
      new Promise((r) => setTimeout(r, 2_500)),
    ]);
    void saved.then(() => httpServer.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 4_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Background jobs (cron passes, the startup chain, alert writes) are fired
// without awaiting. Node 22 ends the process on a rejection nobody handles, so
// one unexpected error in a job would restart the server mid-session and empty
// the in-memory table. Log it instead; each job retries on its own schedule.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled] background task failed:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
