# Database Setup (free) — ~10 minutes

The dashboard runs without a database, but connecting one unlocks everything
that learns: spike baselines, the end-of-day history, sector-relative
analytics, signals and their track record, projections and their grading, and
a scanner table that survives restarts.

## Which free database

The app writes every 30 seconds through each trading session and keeps well
under 1 GB. What matters in a free plan is therefore **no limit on running
hours** and **enough storage**:

| | Aiven Free (recommended) | Supabase Free | Neon Free |
|---|---|---|---|
| Running hours | Always on, not metered | Always on, not metered | **100 compute-hours a month**, then suspended until the next month |
| Storage | 1 GB | 0.5 GB | 0.5 GB |
| Data transfer | Not metered | 5 GB a month | 5 GB a month |
| Backups | Included | None | Yes |
| Connections | 20 | Via its pooler | Plenty |
| Sleeps | Only if unused for a long time (notice first) | After 7 days without activity | After 5 idle minutes; wakes on the next connection |

All three need no credit card. Neon's hour meter is what took this app down in
October 2026 (DECISIONS §0.8a); the app now does far less database work, but a
metered plan still risks a mid-month shutdown, so prefer an always-on one.
Plans change — check each provider's pricing page.

## Aiven (recommended)

1. Sign up at <https://aiven.io> (GitHub login works; no card).
2. **Create service → PostgreSQL → Free plan.**
3. **Region:** the free plan runs in a few DigitalOcean regions. Pick the one
   nearest your app — Railway shows its region under the service's
   **Settings → Region**: US East → **New York**, US West → **San Francisco**.
4. Wait until the service shows **Running** (a few minutes), then copy its
   **Service URI**. It looks like:

   ```
   postgres://avnadmin:AbC123@pg-abc-yourproject.d.aivencloud.com:12345/defaultdb?sslmode=require
   ```

5. In Railway → your service → **Variables**, set `DATABASE_URL` to that URI
   and deploy. The pre-deploy step (`npm run db:push:deploy`) creates the
   tables before the new version starts.

The app limits itself to 5 connections unless the URL sets
`connection_limit` (Aiven's free cap is 20, shared with the pre-deploy step and
the outgoing deploy while a new one starts).

## Supabase (alternative)

1. Sign up at <https://supabase.com> → **New project**, region nearest your app.
2. **Connect → Session pooler** — copy that string (it works over IPv4; the
   direct connection is IPv6-only). Replace `[YOUR-PASSWORD]` with the
   database password you set.
3. Set it as `DATABASE_URL` in Railway and deploy.

Supabase pauses a free project after 7 days with no database activity; this
app writes to it every trading day, so that does not happen while it runs.

## Moving from one database to another

The new database starts empty. On the first start the app:

- refills the scanner table from the feed (after hours: a catch-up to the last
  close, ~15–20 minutes) and captures the day if it was missed;
- backfills ~120 sessions of daily closes for the whole universe from CBOE,
  80 names per maintenance pass (a few trading days for all ~1,400);
- builds volume baselines again from new snapshots (they need 3+ days).

What cannot be rebuilt from the feed — past days' IV, skew, open interest and
gamma, signals, projections and the edge book — lives only in the old
database. Keep it until it has been copied over.

## Verify

- `https://your-app/api/health` shows `"dbConnected":true`.
- The deploy log shows `[poller] loaded N stored baselines` and, after hours,
  `[poller] market closed — catching N names up …`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pre-deploy log: `P1001: Can't reach database server` | The database is asleep or stopped. The step retries for ~2.5 minutes; if it still fails, open the provider's dashboard — the service may be powered off or out of quota. |
| `too many connections` / `remaining connection slots are reserved` | Add `&connection_limit=3` to the URL. |
| `prisma db push` asks for `--accept-data-loss` | The schema changed incompatibly. Run `npx prisma db push --accept-data-loss` once against the database, then redeploy. |
| `/api/health` shows `"dbConnected":false` | The variable must be named exactly `DATABASE_URL`, and the service redeployed after setting it. |
