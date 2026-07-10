# Options Flow Dashboard — Put/Call Volume & Ratio

Real-time options flow analytics for active trading: live put/call ratios, rolling
5-minute flow, volume spike detection with unusual-activity scoring, and spike
alerts across ~250 of the most options-liquid S&P 500 names (extendable to the
full index).

![stack](https://img.shields.io/badge/Next.js%2014-App%20Router-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue)

## What you get

- **Live flow table** — P/C ratio, rolling 5-min put/call volume, net flow,
  premium spent, spike badge, 0–100 unusual-activity score, 30-min ratio
  sparkline. Sortable, sector-filterable, ticker search, pin-to-top, bullish /
  bearish / unusual smart filters, row flash on significant flow, virtualized
  for 500 rows.
- **Aggregate P/C dashboard** — S&P 500 hero ratio with trend arrow, sector
  ratios, per-ticker diverging heatmap, intraday ratio chart with an SPY pane
  on a synced time axis (TradingView Lightweight Charts).
- **Spike detection** — 20-day baseline × intraday time-of-day profile →
  expected volume; elevated (>2×), significant (>5×), extreme (>10×) levels;
  premium + contract-count noise filters; consecutive-cycle confirmation;
  block-trade and single-print heuristics; global sensitivity slider and
  per-ticker overrides.
- **Real-time delivery** — Socket.io push (`flow-update`, `spike-alert`,
  `ratio-update`, `connection-status`) with automatic HTTP-polling fallback.
- **Resilience** — data-freshness dot, simulator mode without an API key,
  graceful no-database mode, per-panel error boundaries, rate-limit-aware
  polling with priority queue and exponential backoff.
- **History** — PostgreSQL (Prisma) storage of 5-min snapshots, aggregate ratio
  points, alerts; CSV export of the live table.

## Quick start

```bash
npm install
cp .env.example .env.local        # add your POLYGON_API_KEY (or leave blank for demo mode)
npm run dev                       # http://localhost:3000
```

**No API key?** Leave `POLYGON_API_KEY` empty and the app runs in **simulator
mode** — synthetic but realistic flow so every feature (table, chart, spikes,
alerts, sockets) works end to end. The status bar shows "SIMULATED DATA".

### With live Polygon data

1. Create a key at <https://polygon.io/dashboard/api-keys>.
2. **Plan matters.** Options chain snapshots require an options-enabled plan:
   - *Options Starter/Developer/Advanced* — set `POLYGON_RPM` to your plan's
     comfortable call rate (e.g. `300`). The poller refreshes the whole
     universe every cycle.
   - *Free tier (5 calls/min)* — it still works: the poller cycles tickers
     through a priority queue (watchlist → spiking → stalest first), so each
     ticker refreshes roughly every `universe / 5` minutes. Trim
     `MAX_TICKERS` (e.g. `20`) for a tight, fast-refreshing board.
3. Put the key in `.env.local` as `POLYGON_API_KEY=...`. It is only ever read
   server-side; nothing key-related is shipped to the browser.

### With a database (optional but recommended)

```bash
# e.g. Railway PostgreSQL — copy its connection string
echo 'DATABASE_URL="postgresql://..."' >> .env.local
npx prisma db push                # create tables
```

Without a database everything live still works; you lose stored baselines,
30-day history, alert audit and ratio percentiles until one is connected.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Custom server (Next + Socket.io + poller) with reload |
| `npm run build` | Production Next.js build |
| `npm start` | Production server (same single process) |
| `npm run worker` | Poller only — for split web/worker deployments |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run db:push` | Sync Prisma schema to the database |

## Architecture

```
Polygon REST (/v3/snapshot/options, /v2/aggs prev)
        │  token-bucket rate limiter + priority queue + backoff
        ▼
   Poller (node-cron, 30s) ──▶ FlowEngine (in-memory: rolling 5-min windows,
        │                        sparklines, aggregate/sector ratios)
        │                              │
        ├──▶ PostgreSQL (Prisma) ◀─────┤   best-effort persistence
        │                              ▼
        └──▶ SpikeDetector ──▶ Socket.io ──▶ React client
                                   ▲               │
                    HTTP API routes └── React Query fallback polling
                                        Zustand UI state
```

- One long-lived Node process (`server.ts`) hosts Next.js, Socket.io and the
  poller and shares the `FlowEngine` singleton — deploy it to Railway, Render,
  Fly.io, a VPS… anything that keeps a process alive.
- **Vercel note:** Vercel's serverless runtime cannot host Socket.io or cron.
  If you want Vercel for the frontend, run `npm run worker` + the API on a
  Railway service and set `NEXT_PUBLIC_SOCKET_URL` to it. The simplest path is
  deploying the whole app to Railway.

## Tuning spike sensitivity

Open **Settings** (gear icon):

- **Sensitivity 0.5×–3.0×** — divides the volume multiple before thresholding.
  Quiet tape / early entries → 0.6–0.8. Fed days, OPEX, earnings season →
  1.5–2.5 to cut noise.
- **Min premium** (default $500K) — the institutional filter; drop it to catch
  smaller names, raise to $1M to see only whales.
- **Min contracts** — floor on rolling window volume.
- **Per-ticker overrides** — `tickerOverrides` in settings (API: `PUT
  /api/settings`) support per-symbol sensitivity/thresholds/mute for naturally
  high-variance names (TSLA, meme tickers).

Alert levels always require **two consecutive confirming cycles**, so one-off
prints don't page you.

## API

| Route | Purpose |
|---|---|
| `GET /api/flow` | Full snapshot: rows, aggregate, sectors, ratio series, status |
| `GET /api/flow/:symbol` | One ticker + stored 30-day history |
| `GET /api/alerts?limit=` | Recent spike alerts |
| `GET/PUT /api/settings` | Read / update detector + UI settings |
| `GET /api/health` | Freshness/status (200 healthy, 503 stale) |
| `GET /api/export` | CSV of the current table |
| `WS /api/socket` | Socket.io endpoint |

## Environment variables

See [`.env.example`](.env.example) — `POLYGON_API_KEY`, `POLYGON_RPM`,
`DATABASE_URL`, `PORT`, `POLL_INTERVAL_SEC`, `MAX_TICKERS`.

## Extending the universe

Edit `src/lib/universe.ts` — add symbols under their GICS sector and raise
`MAX_TICKERS`. Everything downstream (polling, ratios, heatmap, filters)
follows automatically.

## Deployment (Railway, single service)

1. New Railway project → **Deploy from GitHub repo**.
2. Add a **PostgreSQL** plugin; Railway injects `DATABASE_URL`.
3. Service variables: `POLYGON_API_KEY`, `POLYGON_RPM`, `NODE_ENV=production`.
4. Build command `npm run build && npx prisma db push`, start command `npm start`.
5. Railway assigns `PORT` automatically; the server reads it.

## Roadmap / not yet implemented

- Polygon WebSocket trade stream (needs Advanced plan) for true tick-level
  sweep/at-ask detection — the poller architecture accepts it as a second
  ingest source into `FlowEngine`.
- Discord/Telegram/email notifiers, multiple named watchlists, alert-accuracy
  tracker (schema field `Alert.moveNextDay` is ready), open-interest wall
  detection.
