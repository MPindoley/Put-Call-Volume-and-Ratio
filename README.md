# Options Flow Dashboard — Put/Call Volume & Ratio

Real-time options flow analytics for active trading: live put/call ratios, rolling
5-minute flow, volume spike detection with unusual-activity scoring, spike alerts,
and an alert **accuracy scoreboard** across ~450 optionable US names — S&P 500
core plus heavily traded NASDAQ/mid-cap/ADR tickers and sector ETFs, with the
four index benchmarks (SPY = S&P 500, QQQ = NASDAQ-100, DIA = Dow 30,
IWM = Russell 2000) pinned in a dedicated strip.

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
cp .env.example .env.local        # DATA_PROVIDER=cboe works with zero keys/fees
npm run dev                       # http://localhost:3000
```

### Data sources (pick one via `DATA_PROVIDER`)

| Provider | Cost | Latency | Setup |
|---|---|---|---|
| `cboe` *(default)* | **Free** | 15-min delayed chains with per-contract volume | None — no key, no account |
| `massive` | Paid for real-time (free tier = 5 calls/min, end-of-day) | Real-time on options plans | `MASSIVE_API_KEY` |
| `demo` | Free | Synthetic | None — works offline |

- **CBOE (free)** pulls full option chains from CBOE's public delayed-quotes
  CDN. 15-minute delay means spike alerts land ~15 minutes behind the tape —
  fine for ratio context, session flow and swing entries; not for scalping.
  `CBOE_RPM=60` refreshes a 250-ticker universe about every 4 minutes, with
  watchlist/spiking names prioritized.
- **Massive.com is Polygon.io** — the company renamed in October 2025; same
  API, keys and pricing (`api.polygon.io` and `api.massive.com` both work).
  Real-time options snapshots require a paid options plan; set `MASSIVE_RPM`
  to your plan's rate. `POLYGON_API_KEY`/`POLYGON_RPM` are honored as aliases.
  Keys are only ever read server-side; nothing key-related reaches the browser.
- **Simulator** generates realistic synthetic flow so every feature (table,
  chart, spikes, alerts, sockets) can be exercised end to end, even offline.

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
Data provider (CBOE free CDN | Massive/Polygon REST | simulator)
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

See [`.env.example`](.env.example) — `DATA_PROVIDER`, `MASSIVE_API_KEY`,
`MASSIVE_RPM`, `CBOE_RPM`, `DATABASE_URL`, `PORT`, `POLL_INTERVAL_SEC`,
`MAX_TICKERS` (legacy `POLYGON_*` names still honored).

## Volatility & positioning metrics (v5)

Computed every cycle from the same free chain data — per contract IV, delta,
gamma and open interest:

| Metric | Where | Meaning |
|---|---|---|
| **IV30** (+day change) | table + detail | 30-day implied volatility — the market's move forecast |
| **IV Rank** | table + detail | Percentile of IV30 vs stored history (needs DB; matures toward 52wk) |
| **HV20 / IV−HV spread** | detail | Realized vol from CBOE daily history; IV≫HV = fear premium |
| **25Δ risk reversal** | table + detail | Call IV − put IV. Negative = normal put skew; positive = speculative call chasing |
| **Term structure** | detail | ~30d vs ~90d ATM IV; backwardation = imminent-event fear; bulge expiry = likely catalyst date |
| **Implied move** | detail | ATM straddle of nearest expiry as ±% |
| **OI P/C & OI Δ** | table + detail | Positioning (held, not just traded); rising OI + volume = new conviction |
| **Max pain / OI walls** | detail | Strike magnets near expiry |
| **Dealer gamma (GEX)** | detail | + = dealers dampen moves; − = dealers amplify |
| **LEAP IV** | detail | Long-horizon uncertainty |
| **Equity vs ETF/Index P/C** | ratio panel | Retail sentiment vs institutional hedging, split |
| **VIX vs VIX3M** | ratio panel | Market-wide contango/backwardation regime |

**Not included (and why):** sweep/block-at-ask order tagging requires
tick-level trade data (paid real-time feeds only — Massive Advanced tier);
short interest and insider transactions come from different data sources and
are candidates for a later version. None of these metrics is predictive alone
— they're a sentiment mosaic, not trade signals.

## Intelligence jobs (require a database)

With `DATABASE_URL` set (see [docs/DATABASE-SETUP.md](docs/DATABASE-SETUP.md)),
a maintenance job runs at startup and every 2 hours:

- **Baselines** — rolls stored 5-min snapshots into per-ticker 20-day average
  daily volume + stddev, feeding the spike detector real expectations.
- **Alert accuracy** — every alert is scored against the underlying's move
  ~1 trading day later; the **Accuracy** tab shows hit rates by severity
  (put-heavy alert → down move = hit, call-heavy → up move = hit).
- **Retention** — snapshots kept 35 days, ratio history 90, alerts 120.

The **Leaders** tab (most unusual, premium leaders, strongest directional
flow) works with or without a database.

## Extending the universe

Edit `src/lib/universe.ts` — add symbols under their GICS sector and raise
`MAX_TICKERS`, then run `node scripts/validate-universe.mjs` to confirm every
symbol resolves on the CBOE feed. Everything downstream (polling, ratios,
heatmap, filters) follows automatically.

## Deployment (Railway, single service)

1. New Railway project → **Deploy from GitHub repo**.
2. Add a **PostgreSQL** plugin; Railway injects `DATABASE_URL`.
3. Service variables: `DATA_PROVIDER=cboe` (or `massive` + `MASSIVE_API_KEY`),
   `NODE_ENV=production`.
4. Build command `npm run build && npx prisma db push`, start command `npm start`.
5. Railway assigns `PORT` automatically; the server reads it.

## Roadmap / not yet implemented

- Massive/Polygon WebSocket trade stream (needs their Advanced plan) for true
  tick-level sweep/at-ask detection — the provider architecture accepts it as
  another ingest source into `FlowEngine`.
- Discord/Telegram/email notifiers, multiple named watchlists, alert-accuracy
  tracker (schema field `Alert.moveNextDay` is ready), open-interest wall
  detection.
