/**
 * Standalone poller worker — run this when hosting the data pipeline
 * separately from the Next.js frontend (e.g. Railway worker + Vercel web).
 * It runs the same Poller without a socket server; clients then rely on
 * React Query polling against the API routes, backed by the shared database.
 */
import { Poller } from '../src/lib/poller';

const poller = new Poller(null);
poller.start();
console.log('[worker] data poller running (no socket server; persisting to DB)');

process.on('SIGINT', () => {
  poller.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  poller.stop();
  process.exit(0);
});
