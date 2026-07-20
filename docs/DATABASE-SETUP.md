# Database Setup (Neon + Render) — 15 minutes, free

The dashboard runs without a database, but connecting one unlocks the
intelligence layer: real 20-day spike baselines, 30-day history, ratio
percentiles, the alert **accuracy scoreboard**, and settings that survive
restarts. This guide uses **Neon** (free Postgres that doesn't expire, unlike
Render's own 30-day free database).

## Step 1 — Create the Neon database (~5 min)

1. Go to <https://neon.tech> → **Sign up** (you can use your GitHub login).
2. Create a project:
   - **Name:** `optionsflow` (anything works)
   - **Postgres version:** default is fine
   - **Region:** pick the one matching your Render region — Render's default
     is Oregon (US West), so choose **AWS us-west-2 (Oregon)**. If your Render
     service is in Ohio/Virginia, pick the matching US East region instead.
3. On the project dashboard, find **Connection string**. Choose the
   **direct/unpooled** connection option, and reveal/copy the full string.
   It looks like:

   ```
   postgresql://neondb_owner:AbC123xyz@ep-cool-name-a1b2c3d4.us-west-2.aws.neon.tech/neondb?sslmode=require
   ```

   Keep `?sslmode=require` on the end — Neon requires SSL. (The app is one
   long-lived server with a handful of connections, so the direct string is
   the right choice over the pooled one.)

## Step 2 — Give it to Render (~2 min)

1. Render dashboard → your service → **Environment**.
2. **Add Environment Variable:** key `DATABASE_URL`, value = the full
   connection string from step 1.
3. Save. Render redeploys automatically.

## Step 3 — Create the tables (~2 min)

Render's free tier has no shell access, so table creation runs during the
build instead:

1. Render → your service → **Settings** → **Build Command** → change it to:

   ```
   npm install && npm run build && npx prisma db push
   ```

2. Save, then **Manual Deploy → Deploy latest commit**.
3. Watch the logs: after the Next.js build you should see Prisma connect and

   ```
   🚀  Your database is now in sync with your Prisma schema.
   ```

This is safe to leave in place permanently — `prisma db push` is a no-op when
the schema hasn't changed, and applies new tables automatically whenever you
upload a new version of the app.

## Step 4 — Verify (~1 min)

- The dashboard's status bar should now show **"DB connected"** instead of
  "DB off — live only".
- `https://your-app.onrender.com/api/health` shows `"dbConnected":true`.

## What happens next (automatic)

- Every poll cycle stores 5-minute snapshots; every fired alert is recorded.
- A maintenance job (every 2 hours) rolls snapshots into **20-day per-ticker
  baselines**, scores day-old alerts against the next day's move
  (**Accuracy** tab), and prunes old data (35-day snapshots, 120-day alerts)
  so the free tier's 0.5 GB storage is never a problem.
- Expect the Accuracy tab to show its first scored alerts **the day after**
  the first alerts fire, and baselines to reach full strength after ~20
  trading days of collection.

## Important: keep it collecting

Data only accumulates while the Render instance is awake. Set up a free
pinger so it runs through every session:

1. Sign up at <https://cron-job.org> (free).
2. Create a job: URL = `https://your-app.onrender.com/api/health`,
   schedule = **every 10 minutes**, Monday–Friday, 9:00–16:30 in
   **America/New_York** time.

Without this, the instance sleeps 15 minutes after your last visit and stops
recording — baselines and accuracy stats will build much more slowly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log shows `P1001: Can't reach database server` | Connection string typo, or Neon project is in a very distant region. Re-copy the string; confirm `?sslmode=require` is present. |
| `prisma db push` asks for `--accept-data-loss` | Only happens if the schema changed incompatibly between versions. Add `--accept-data-loss` to the build command once, deploy, then remove it. |
| Status bar still says "DB off" | The env var is named exactly `DATABASE_URL`? Redeployed after adding it? |
| Neon shows the database "idle" | Normal — Neon free tier autosuspends after 5 min without queries and wakes in ~1 s on the next one. |
