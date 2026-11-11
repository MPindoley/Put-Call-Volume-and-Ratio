# Design decisions

Briefing for a reviewer with no prior context. Every entry records a deliberate
decision, why it was made, and **what breaks if it is reversed**. Companion
document: `METRICS.md` (formulas, thresholds, failure modes). The operator is a
quant who reviewed each increment; several decisions below reverse an earlier
implementation on their instruction — those reversals are flagged, because
"simplifying" them back would reintroduce a known defect.

Conventions used everywhere:
- **ET (America/New_York) is the time basis** for every date boundary
  (`etDateKey` in `trading-calendar.ts`). The operator is US-Eastern; a UTC
  boundary once caused day-over-day OI comparisons to treat "today" as "prev".
- **Free-data constraint**: CBOE delayed public CDN + SEC EDGAR + local compute
  only. No paid feeds, nothing scraped or flaky. The one exception is the
  operator's own Schwab account (free to account holders, personal use), and
  only as a flow overlay (§0.10).
- **Refuse rather than guess**: when an input is missing or a threshold isn't
  met, the system shows `—` / "warming" / null-with-reason. Reversing this
  anywhere (filling gaps, clamping, guessing) breaks the operator's core trust
  contract: "live-verified must mean live".

---

## 0. Platform

### 0.1 CBOE free delayed feed as the default provider (`cboe.ts`)
`cdn.cboe.com/api/global/delayed_quotes` serves full option chains (per-contract
IV, delta, gamma, OI, bid/ask), index quotes (`_VIX`, `_VIX3M`) and ~20 years of
daily OHLC — free, keyless, 15-min delayed. **Reasoning:** the operator refused
recurring fees. **If reversed** (paid feed): fine functionally, but every module
assumes 15-min delay semantics and per-contract chain shape (`RawContract`);
`bid`/`ask` presence gates the event liquidity floor.

### 0.2 In-memory FlowEngine singleton on `globalThis`, DB as best-effort history
The live dashboard runs entirely from memory (`flow-engine.ts`); Postgres is
graceful-degradation persistence (`tryDb` swallows failures). **Reasoning:**
Render free tier + Neon free Postgres; the dashboard must survive DB outages.
**If reversed** (DB-required reads on the hot path): the free-tier deploy dies on
every cold start and DB hiccup.

### 0.3 Custom server (`server.ts`): Next + Socket.io + node-cron in one process
**Reasoning:** one free-tier web service must host UI, websocket pushes, the
poller and all cron jobs. **If reversed** (split services): exceeds the free
tier; the engine singleton would need external state.

### 0.4 All build/runtime deps in `dependencies` (only vitest in devDeps)
**Reasoning:** Render builds with `NODE_ENV=production`, which skips
devDependencies — a build once failed on a missing module. **If reversed:** the
deploy build breaks again.

### 0.5 Flow is timed by the DATA's clock, and short windows are rates (`flow-window.ts`)
A chain snapshot reports cumulative day volume; the difference between two is
the volume traded between their DATA times (CBOE: snapshot timestamp − 15 min,
`snapshotDataTime`). Each delta is an interval; "Puts/Calls 5m", net flow, 5m
premium and the windowed P/C cover the five minutes of data ending at the newest
snapshot, pro rata across straddling intervals, scaled to a per-5-minute rate.
A snapshot no newer than the last is ignored (the CDN re-serves stale ones —
measured: one name's snapshot 15 min older than SPY's at the same moment).
**Reasoning:** summing whatever arrived in the last five wall-clock minutes made
a hot name's "5m" cover ~2 minutes and a typical one's ~9, recorded a false lull
for every re-served snapshot, and counted it as a second confirming cycle for
spike alerts. Rows carry `dataAsOf` (shown as "As of") and `flowWindowMs`;
snapshots persist under the bucket of their data time; the detector's
time-of-day expectation uses the data time. **If reversed:** cross-name
comparisons of short-window flow are meaningless again.

### 0.6 Tiered refresh within the rate budget (`refresh-schedule.ts`)
Watchlist, spiking, benchmark and the ~100 most active names have a 3-minute
base interval, the next 300 10 minutes, the rest 30; the base intervals are
scaled together so total demand equals `CBOE_RPM`, and each cycle takes the
most overdue names. Activity = today's session option volume, else the last
recorded day's. Order within a cycle: due names (most overdue first), then
never-fetched names (busiest first), then the rest; a never-fetched name counts
elapsed time from startup. Measured live after a restart, both simpler rules
failed: never-fetched-first spent the whole first ~16-minute pass on first
fetches (no second snapshot, so no 5-minute rate, even for SPY);
most-overdue-first kept re-fetching the first hundred names before they were
due and stalled the backlog. Cycles run back to back: a cycle's
batch is one interval of budget paced at exactly the budget rate, so on a fixed
cron tick every other tick was skipped (≈ half the rate idle). HTTP 403/404 is
not retried, and a failed attempt is stamped so the name waits its interval
instead of being re-picked first forever. **Reasoning:** with ~1,400 names a
uniform rotation would make every name wait ~16 minutes at 90/min, while most
volume sits in the top few hundred. **If reversed:** universe size trades
directly against freshness.

### 0.7 Universe = curated core + measured extension (`build-universe.mjs`)
The hand-curated ~540 names stay; `universe-extended.ts` adds names chosen by
MEASURED total open interest from CBOE chains (pre-ranked by dollar volume;
leveraged/inverse ETFs excluded), sectors mapped from Nasdaq industry text (85%
agreement with the curated core's hand-checked sectors; the rest are genuinely
ambiguous cases such as interactive media vs software). Generated, not edited;
re-run every few months. **Reasoning:** "as many stocks as possible" on a free
feed means the names whose options actually trade; ~4,400 have listed options
but most trade too thinly for a meaningful ratio. `CBOE_RPM` default 60 → 90,
now a CEILING: the CDN's tolerance depends on burstiness and its own load (an
even 3 req/s drew 38 429s in ~2,200 requests; live at 90/min the app drew 2–16
per run, most near the close). The token bucket therefore cuts its rate by a
quarter on a 429 (once per pause), recovers 5% of the ceiling per quiet minute,
banks at most ~5 s of budget, and accrues nothing during a pause — measured
before this, each pause ended in a 20+ request burst that drew the next 429.

### 0.8 Storage stays inside a free 0.5 GB database
Measured on Postgres: ~180 B per FlowSnapshot row, ~300 B per DailyMetric row
(with indexes). Intraday snapshots keep full resolution for 5 days, then thin
to the last row per symbol per day (`downsampleSnapshots` — cumulative, so it
carries the day totals baselines read); RelativeMetric gets the same 400-day
horizon as DailyMetric. **Reasoning:** at ~1,400 names untrimmed snapshots alone
reach ~140 MB and RelativeMetric grows ~140 MB a year. **If reversed:** the free
database fills within about a year.

### 0.8a Database work only when there is new data
Neon's free plan meters compute hours (100 a month), and the app used them up
by mid-October: a maintenance pass every 2 hours, around the clock, each
re-reading whole tables (a year of daily rows for IV rank, every close for
event detection, the full learning history for the edge book) whether or not
anything had changed, plus the Schwab loop reading its sign-in every minute
overnight (fixed in #15). Now (`history-jobs.ts`, `poller.ts`):
- **Maintenance runs on trading days, 9:00–21:00 ET** (`maintenanceWindow`),
  plus once at startup. Overnight and at weekends nothing it reads changes.
- **Whole-table jobs run when their inputs change.** Baselines, event
  detection, signal and projection grading, the edge book and retention run
  only when `dailyInputsKey` (ET date + latest finalized date + finalized row
  count) differs from the last pass that ran them: the first pass of the day
  and the one after the end-of-day capture. IV rank still follows live IV every
  pass, against a cached copy of the stored history keyed the same way.
- **One statement per cycle for snapshots.** A cycle's intraday snapshots are
  one `INSERT … ON CONFLICT` (`upsertFlowSnapshots`) instead of up to 500
  Prisma upserts (a read and a write each) every 30 seconds.
- **One baseline row per symbol.** Baselines were inserted for every name on
  every pass and kept 45 days (~750k rows, the largest table); the loader only
  reads the latest, so only the latest is kept, written in one insert.
- **Close backfill continues in maintenance** (80 names a pass, each tried once
  per process), so a new, empty database has the universe's price history
  within a few trading days instead of 80 names per restart. It runs LAST in
  the pass, and at startup only the 4 benchmarks are fetched first (the regime
  seed needs SPY): while the session's polling holds the rate budget, 80
  low-priority fetches take most of an hour, and on a new database every other
  job used to wait behind them.
- **Connection pool of 5** unless the URL says otherwise; Prisma's default
  (2 × CPUs + 1) can exceed a free plan's cap (Aiven: 20).
- **Raw SQL pins times to UTC** (`AT TIME ZONE 'UTC'`), so a database whose
  session time zone is not UTC stores and compares the same instants.
**Reasoning:** the app should run on a free database indefinitely. **If
reversed:** a metered free plan runs out mid-month, and a capped one fills with
duplicate baselines.

### 0.8b Moving databases: a one-time, in-app import
The move to Aiven happened while Neon had locked the old project until the next
month, so the history could not be copied first. `IMPORT_DATABASE_URL`
(`db-import.ts`) copies it later, from inside the app, so no database password
leaves the host: tried at startup and hourly until the old database answers,
then recorded in `DataImport` and never repeated. Merge rule: the current row
wins on its natural key, except over a weaker stand-in for the same fact (a
close-only backfill, a backfilled regime row without gamma); edge books built
on the new database are derived from a few days of history, so they are
replaced and the recent ones rebuilt from the merged evidence
(`reconstructed: true`). Copying is idempotent (skip-on-conflict), so an
attempt that fails part-way is repeated whole. **If reversed:** a manual
dump/restore would have to wait for the lock, run outside the app with both
passwords, and resolve the overlap by hand.

### 0.9 Outbound bytes: compact price ticks, compressed frames
Live-price sweeps push `[symbol, price, change%, time]` tuples (`quote-update`),
not full rows; socket frames over 1 KB are deflated; the full table is sent once
per connection (on the client's `request-snapshot`), not twice; the ticker page
reads its latest 100 snapshots, not 30 days of them every 15 s. **Reasoning:**
outbound traffic is what a host meters; resending every ~3 KB row each minute
to move one price was the largest stream. The Yahoo sweep covers the hot set
every minute and the whole universe every 5 minutes, keeping its request rate
near the old 552-name sweep.

### 0.10a Restart safety: saved table, after-hours catch-up, capture guard
The scanner table lives in memory, and a deploy restarts the process. Three
measures keep a restart from costing data (`engine-snapshot.ts`, `poller.ts`,
`history-jobs.ts`):
- **Saved table.** Every row and projection is saved (one gzip'd row,
  ~3 MB for ~1,400 names) every 10 minutes while polling, at the close, after
  a catch-up and at shutdown, and restored before anything polls. Rows keep
  their own data times; no feed state is restored, so the next live snapshot
  starts a fresh measurement window (no delta against a snapshot this process
  never saw).
- **After-hours catch-up.** A start while the market is closed refreshes, once,
  every name whose data predates the last session's close (minus 20 min) —
  the feed still serves the closing snapshot — then idles. CBOE re-stamps that
  snapshot after the bell, so a data time past the close is pinned to the close.
- **Capture guard.** The pinned end-of-day capture refuses to pin a day while
  fewer than half the universe holds that session's data (a finalized row is
  never re-captured, so a partial pin would be permanent). After a catch-up,
  a late capture runs if the window was missed (same ET date only; after the
  close the values are the ones the window would have seen).
- **One regime exception.** A final regime row written before its day was
  captured (no gamma input while the day's captured GEX exists) is rebuilt
  once; every properly captured row stays immutable (4.2).
**If reversed:** a deploy just after the close loses the day's capture and
writes a regime row from yesterday's SPY close — permanently.

### 0.10 Schwab real-time is a FLOW overlay; CBOE stays the analytics of record
With the operator's Schwab connection (`schwab-auth.ts`, `schwab.ts`,
`realtime-feed.ts`), a second loop fetches real-time chains for a hot set
(watchlist, benchmarks, spiking, top `SCHWAB_HOT_SYMBOLS` by option volume,
with 1.5× rank hysteresis) at ~100 requests/min. Schwab supplies ONLY the flow
half of a row: volumes, P/C, premium, spike detection, and the live price.
IV30, skew, OI, GEX and the event gauge stay on CBOE for every name, and so
do three of the four graded signals (skew_z, divergence, pc_extreme). Two
volume-based inputs do pick up the real-time count on hot names: spike alerts
(hence the spike_alert signal) fire from real-time data under the same rule,
just earlier, and the day's option-volume total (`optVolume`, a liquidity
floor) is the real-time session count. That is deliberate: a contract count
is a fact both feeds agree on, counted the same way; IV is not. Each feed keeps its own session state per
ticker (`FlowEngine` `primary` / `realtime`): deltas are only ever taken
between two snapshots of the same feed, the overlay takes over a row only
once it has measured a window of its own (≥1 min), and the delayed feed
takes the row back 10 minutes after real-time data stops. Spike detection
runs on exactly one feed per ticker at a time. Rows say which feed they are on
(`realtime`). **Reasoning:** IV rank, sector z-scores and the signal history
were built on CBOE's IV methodology; Schwab's differs, so mixing them would
move those statistics for reasons that are not market moves. Volumes are
counted the same way on both (standard contracts, mid × volume × 100).
**If reversed:** cross-feed deltas read the two feeds' count difference as
trading (phantom spikes at every hand-off); Schwab IV in the history shifts
IV rank and the learned edges.

### 0.11 Site lock, and Schwab only behind it
`SITE_PASSWORD` locks pages, API routes and the socket (`middleware.ts`,
socket `allowRequest`) with an HMAC-signed 30-day cookie; `/login`, the
health probe and static assets stay public. Schwab polling refuses to run
while the site is open, and the connect/callback routes require the lock plus
an OAuth `state` cookie. Tokens are stored AES-256-GCM encrypted (key derived
from the app secret, never in the database) and never leave the server.
**Reasoning:** Schwab licenses the data to the account holder; a Railway URL
is public to anyone who has it. **If reversed:** real-time broker data is
redistributed to whoever finds the URL, and a crafted callback could attach
someone else's Schwab login.

---

## 1. Sector-relative layer (Phase 1)

### 1.1 Cohort model: "one name, one peer group" (`sector-benchmarks.ts`)
Relative analytics are keyed by **benchmark ETF**, not GICS sector. A per-ticker
override (NVDA→SMH, biotech→XBI) moves the name **out** of its GICS median —
membership is mutually exclusive. **Reasoning (operator's call):** a name must
never be compared against two different peer groups at once, and a median must
not contain a name whose "true" peers are elsewhere. **If reversed** (overrides
stay in the sector median too): double-counting; the sector median is polluted
by names that are being scored against a different benchmark.

### 1.2 Composition versioning (`compositionVersionFor`, FNV-1a hash)
Every stored cohort median and relative-spread row is stamped with a hash of the
membership definition + filter config; rolling windows filter to the **current**
version. **Reasoning:** editing cohort membership must not silently redefine
history — a 90-day window spanning two definitions is a different statistic.
**If reversed:** percentiles and z-scores quietly mix two universes; a
composition edit retroactively changes past signals' meaning.

### 1.3 Pinned end-of-day capture, provisional vs final (`finalizeDailyCapture`)
One finalized row per ticker/day, captured in a post-close ET window gated by a
real NYSE trading calendar (holidays, half-days, Good Friday via computus), with
a delay for the 15-min feed to flush. `final=false` provisional rows never feed
statistics. **Reasoning:** cross-sectional medians require every ticker captured
at a comparable real close. **If reversed** (compute stats from whatever-time
snapshots): medians mix 10am and 4pm states; day-over-day changes become noise.

### 1.4 `historicalCloseOnly` backfill rows never masquerade as full rows
20-year price backfill writes close-only rows flagged so nothing downstream
treats them as IV/OI-bearing. Backfill never overwrites an existing row.
**Reasoning:** historical IV/OI does not exist in the free feed and must never
be fabricated. **If reversed:** nulls or fabricated values enter IV/skew/OI
statistics.

### 1.5 Guarded z-scores (`zScoreGuarded`: minObs 20/60, stdev floor 0.1)
**Reasoning:** a live incident — a near-zero stdev window produced z = +13.4.
**If reversed:** early-history z-scores blow up and the regime/divergence layers
built on them fire spuriously.

### 1.6 Median membership filter (liquidity floors + IQR fence, 2.5×) and
`minConstituents` (5) — a cohort below the floor yields a **null** median.
**If reversed:** thin cohorts emit garbage medians that look authoritative.

### 1.7 Dispersion weighting cascade (cap → OI → equal) with the method stamped
on every stored point; windows never mix methods; method change recomputes the
series. **If reversed:** a percentile of mixed-method points is uninterpretable.

---

## 2. Interpretation layer (Phase 2)

### 2.1 Inverse/leverage flips at the SURFACE, raw data untouched
SQQQ etc. are flagged (`TickerOverride.inverse`, `leverage`); sentiment labels
flip to underlying-exposure terms at render/emission (`interpretation.ts`), while
stored values stay raw. **Reasoning:** stored data must remain the market's
facts; interpretation is a view. **If reversed** (flip in storage): every
downstream consumer must know history was pre-flipped; changing the instrument
list would corrupt stored history.

### 2.2 OI tiebreaker uses a documented per-side IV approximation, with raw
inputs stored: side IV change ≈ dIV ± dSkew/2. The raw `iv30Change`/`skewChange`
are persisted next to every classification so thin decompositions are auditable.
**If reversed** (hide the inputs): the operator cannot audit
demand/supply/unwind/short-cover calls that came from a fragile decomposition.

### 2.3 Divergence is a labeled heuristic; Newey-West t is the audit statistic
The screen uses plain OLS slope t-stats (threshold 1.5) and is labeled a
heuristic; a Bartlett-HAC (Newey-West) t is computed and stored alongside for
audit, because overlapping daily series are autocorrelated and OLS t overstates
significance. **If reversed** (present OLS t as significance): the flag claims
rigor it doesn't have — the operator presents to professionals.

### 2.4 Seed safety (`seed-guard.ts`)
`seeded` flag on every syntheticable table; `assertSeedAllowed` throws under
`NODE_ENV=production` or without `ALLOW_SEED=1`; **every** statistic filters
`seeded:false`; one-command purge. **Reasoning:** a synthetic-seed incident
polluted a live-looking statistic once. **If reversed:** demo/synthetic rows can
reach deployed statistics. The Phase-4 matrix demo mode reuses this same guard —
do not give it a weaker one.

---

## 3. Event layer (Phase 3 + EDGAR)

### 3.1 Event variance decomposition (`event-variance.ts`) — four guardrails
Two-expiry extraction of a one-session implied event move, `V_i = σ_d²τ_i + v_e`:
1. **Non-positive event variance → null with a logged reason, never clamped to
   zero.** Thin quotes/stale sides regularly price a near expiry below a far one
   for non-event reasons; clamping turns a data problem into a plausible small
   event move. **If reversed:** the rich/cheap distribution silently absorbs
   data artifacts.
2. **Trading days (τ = td/252), event as a single-day lump.** Calendar days
   attribute diffusion to weekends/holidays, inflating σ_d² and deflating v_e.
3. **Adjacent bracketing expiries only, both over a configurable liquidity
   floor (min ATM OI, max quote width from real bid/ask); refuse otherwise.**
   A distant expiry's diffusive vol genuinely differs — reaching for it changes
   the quantity being measured.
4. **Realized moves timing-matched** (bmo: prior→event close; amc: event→next
   close; unknown → flagged `realizedTimingUncertain` and excluded).
Reversing any guardrail corrupts the implied-vs-realized comparison the
rich/cheap gauge depends on.

### 3.2 REVERSAL: price-history inference is NOT an earnings source
An earlier build inferred earnings from outsized price moves. Two field defects:
(a) it labeled the 2025-04-09 market-wide tariff gap a high-confidence AAPL
earnings event, and (b) recall of true earnings was ~50% with false positives
like WWDC. The operator ordered it removed as an earnings source. Earnings now
come from the calendar only: `manual` (ground truth), `edgar`, `forward`
(bulge-identified + operator-confirmed). **If reversed** (re-adding inference to
the earnings distribution): known-wrong events re-enter the rich/cheap
statistic. The detector itself was **repurposed**, not deleted → 3.3.

### 3.3 Idiosyncratic-move feed (`idiosyncratic.ts`) — detector repurposed
Detects large unscheduled single-name moves on the **residual vs SPY** (rolling
60-day regression, no look-ahead), with three safeguards: market-wide-day
exclusion (breadth filter: a date where ≥50% of the universe moved ≥3σ is a
market event), a minimum raw-move floor (2%: a large residual with a ~0% raw
move is a benchmark artifact — one 62σ Memorial-Day artifact motivated this),
and MAD-based robust sigma with stdev fallback. **SPY, not the sector ETF,
deliberately**: a mega-cap is a heavy weight in its own sector ETF, which
absorbs the name's move and shrinks the residual (measured: AAPL vs XLK missed
events AAPL vs SPY caught). The sector ETF remains correct for sector-relative
sentiment — two different questions, two different benchmarks. **If reversed**
(sector benchmark for residuals, or feeding this into earnings): mega-cap
recall collapses / known-bad events re-enter the earnings stats.

### 3.4 Rich/cheap gauge: confirmed events only, suppressed until 8
The gauge ranks live implied vs realized moves of **confirmed** events only and
shows "insufficient confirmed history (N/8)" — no number — below the threshold.
The operator explicitly reversed an interim rule that let high-confidence
inferred events count. **If reversed:** the gauge displays percentiles against a
distribution containing non-earnings moves; suppression-as-correct-state is a
deliberate UX stance, not a missing feature.

### 3.5 EDGAR (`edgar.ts`): 8-K Item 2.02 as ground truth
- **Acceptance timestamp → report timing** (≥16:00 ET amc, <09:30 bmo, else
  intraday; DST-aware), replacing the timing-uncertain flag for EDGAR events so
  they enter the statistic on the correct session. Raw `acceptedAt` stored for
  audit. **If reversed** (use filingDate): after-close releases carry the same
  calendar date as the pre-reaction session — realized moves get measured on the
  wrong session.
- **Quarterly spacing (≥45d) before acceptance; too-soon filings stored
  `pendingReview`, never auto-accepted and never silently dropped** — prelims
  and guidance reuse Item 2.02. **8-K/A amendments skipped** → no duplicates.
- **Declared User-Agent with contact email + <10 req/s throttle** (SEC blocks
  otherwise); **official `company_tickers.json`** for ticker→CIK (CIK survives
  ticker changes); **every fetch cached** (`EdgarCache`, TTL) so backfills never
  re-hit SEC.
- Forward events near an EDGAR filing are **superseded in place** (no dupes).
- There is deliberately **no forward earnings-calendar feed**: no reliable free
  one exists; forward scheduling stays bulge-identified + operator-confirmed.

---

## 4. Regime-conditional accuracy (Phase 4)

### 4.1 Regime dimensions are BINARY; deadband + persistence; neutral only at init
Vol (VIX3M−VIX sign), trend (SPY close vs 50-day; SPY is the SPX proxy —
dividend drift is immaterial at 50 days), gamma (aggregate dealer-gamma sign).
The operator explicitly rejected an ongoing "neutral" third state: it duplicates
the hysteresis and takes the space from 8 to 27 cells, so nothing would clear a
20-sample floor. Instead: values inside a per-dimension deadband **hold the
prior state** and clear pending flips; the opposite side must persist 2
consecutive days to flip (`regime.ts`, pure + tested). **If reversed** (neutral
as a state, or no hysteresis): cell samples fragment; boundary-hugging days flip
regimes daily and scramble cell assignment.

### 4.2 Regime rows are immutable and versioned; gamma NULL for backfill
`DailyRegime` is computed forward-only from the prior day's stored state, frozen
once `final`, stamped `regimeConfigVersion`. Vol/trend history is reconstructed
from stored VIX/SPY closes; **gamma is NULL before live capture** because
historical OI/IV does not exist — it is never fabricated, and pre-gamma signals
are bucketed as a separate γ-n/a column, not dropped. Aggregate gamma is stored
**two ways** (net summed GEX — classified on sign but dominatable by one large
position — and breadth, the share of tickers positive), both **universe-scoped**.
**If reversed** (recompute history on retune, fabricate gamma, drop 2-D
signals): point-in-time integrity is gone — a knob change would silently rewrite
what regime every past signal fired in.

### 4.3 Signal log: fixed grid, immutable rows, PIT emission (`signal-jobs.ts`)
One row per (ticker, type, finalized session), emitted at EOD only after the
regime row is final, only from finalized non-seeded data, idempotent, never
recomputed under later baselines. The grid was **fixed before any results
existed** (multiple-comparisons discipline): directional = divergence, skew_z
(|z|≥2), pc_extreme (OI-based P/C ≥1.3/≤0.7), spike_alert; tracks = event_badge,
backwardation, regime_detach. Any future signal is a NEW type reported
separately. Continuous magnitude is stored beside every flag, with a documented
warning that re-thresholding after seeing outcomes is overfitting. All cutoffs
hash into `thresholdVersion`; no scoring window spans two versions.
**If reversed** (recompute past signals, fold new types in, tune thresholds in
place): the accuracy matrix becomes unfalsifiable — the exact criticism a
professional reviewer would raise.

### 4.4 Non-fire denominators are reconstructible — state persisted for it
The regime-matched base rate needs "all days a signal *could* have fired." An
audit found two signals whose eligibility state wasn't persisted; both are now
daily columns on `DailyMetric`: `termSlope` (+ `atmIvNear`/`atmIvFar`
components) and `spikeBaselineDays`. **If reversed** (drop those columns): the
could-have-fired denominator can never be rebuilt for those signals — the data
simply won't exist.

### 4.5 ETFs are excluded from the directional matrix
ETF/index put flow is structurally hedging (the same reason the ratio panel
splits equity from ETF), so a put-heavy SPY reading is not a bearish bet. Every
signal row carries `isEtf`; ETF signals stay logged but route to a reference
panel, excluded from the matrix AND its base-rate denominators (an ETF in a
cohort pool would corrupt the no-skill baseline). **If reversed:** the
pc_extreme row of the matrix fills with hedging flow and its "accuracy" is
meaningless.

### 4.6 Hit is defined on the EXCESS return; base rates are REGIME-MATCHED
A bullish signal returning +2% in a +4% market is not a hit; raw is an explicit
toggle. Each cell's headline is hit-rate **minus the regime-matched base rate**:
the no-skill probability over all eligible same-regime days (signal or not),
per-ticker, with cohort pooling below 60 in-regime days and the denominator
labeled (ticker/cohort/mixed). The operator explicitly rejected all-period
unconditional base rates: they confound signal with regime — the matrix would
mostly rediscover that stocks behave differently in backwardation.
**If reversed:** hit rates flatter every signal in trending markets and the
excess column answers the wrong question.

### 4.7 Statistical honesty lives in the payload, not just docs
Wilson CI per cell; `cellsTested` and `expectedByChance` (α·cells) reported;
suppression below 20 samples (n stays visible); permanent "exploratory" banner
(overlapping windows are autocorrelated); warming state ("N signals logged,
first scoring DATE") instead of empty cells — scoring is single-shot at 20
trading days. **If reversed** (hide n, drop the banner, show partial scores):
the matrix will not survive "how many cells did you test?" from a professional.

### 4.8 Backwardation episodes: curve-shape resolution primary, method stamped
Episodes (contiguous `termSlope < −0.5` runs) close with a PRIMARY resolution by
curve shape — `front_collapse` (near fell to meet the back: fear passed) vs
`back_lift` (far rose to meet the front: fear repriced durable) — from persisted
components, with the outcome classes (realized_move/iv_crush/faded) demoted to a
secondary label (operator's call: curve shape is the interpretable axis).
`resolutionMethod` stamps whether components or the iv30+slope proxy classified
the episode (episodes predating component capture), and resolution stats carry
the split — proxy and component classifications never silently mix.
**If reversed** (outcome primary, or unstamped proxy mixing): the
resolution-vs-forward-return analysis loses its interpretable axis and mixes two
measurement methods invisibly.

### 4.9 Demo mode carries the production seed guard
The populated-grid preview (`?demo=1`) goes through `assertSeedAllowed`: HTTP
403 under `NODE_ENV=production`, requires `ALLOW_SEED=1` elsewhere, payload
stamped `demo:true` + bannered. **If reversed** (a merely-unused flag): synthetic
accuracy numbers become one query-param away from a production screen.

---

## 5. Learning loop (edge book, conviction, self-grading)

The app learns which of its OWN signals work and weights what it shows by that.
Code: `learning.ts` (pure math), `learning-data.ts` (inputs), `learning-jobs.ts`
(nightly job, report). It does not learn prices, and it never adds signals.

### 5.1 Learned edge = hit rate above the regime-matched base rate, shrunk
Evidence is §4.6's definition unchanged: 10-session excess vs SPY, hit on the
predicted side, measured against the regime-matched no-skill rate. Estimates
shrink along a strictly nested chain — 0 → signal → ·regime → ·sector →
·ticker — each moving from its parent in proportion nEff/(nEff+k), k =
40/40/60/80. **If reversed** (raw per-stock hit rates): with ~540 names, a few
look brilliant by luck every month, and the scan table would rank them first.

### 5.2 Not a fitted model
No regression, tree or network. At hundreds to low thousands of graded signals
a model memorises noise and backtests beautifully. The signal grid stays fixed
(§4.3); learning only weights it. **Revisit** when graded signals number in the
many thousands and self-grading (5.6) shows the simple weighting has stalled.

### 5.3 Recency half-life of 120 sessions
Evidence weight halves every ~6 months by fire date. **If reversed** (equal
weight forever): a signal that stopped working coasts on old wins indefinitely.

### 5.4 Point-in-time books, immutable and versioned
A book dated D sees only outcomes knowable by D (a terminal name only after its
quiet period) and base rates as known at D. One row per (asOf, version); never
rewritten. Past books are reconstructed on first run and flagged. The version
hashes every constant that changes a book's meaning (params, base-rate floor,
frozen rule, conviction combination, thresholds, regime config). **If
reversed**: self-grading would grade the app on answers it peeked at.

### 5.5 Refuse thin or ghost inputs
- A base rate needs ≥ 30 observations (`MIN_BASE_SAMPLE`); below it the row is
  *unbased* and skipped. Measured reason: early point-in-time bases resting on
  2–3 days read 0%/100%; a replay over data whose true base was ~50% averaged
  37% and inflated the measured edge by ~13 points.
- Sessions in a run of ≥ 5 identical closes (`FROZEN_RUN_SESSIONS`) are a
  halted/delisted name's ghost price — excluded from evidence and base rates.
- Names that stop trading mid-window are graded to their last close
  (`terminalOn`), not dropped (survivorship); sectors come from the persisted
  Ticker row when a name has left the universe.

### 5.6 The app grades itself
Every past conviction is replayed point-in-time and graded: claimed vs
delivered excess, by strength bin and by month, plus a Brier skill score
against the no-skill forecast. A skill ≤ 0 is reported as such. **If removed**:
"the app is learning" becomes unfalsifiable.

### 5.7 Conviction combination: signed sum ÷ √m, capped at 25 points
Co-firing signals are often correlated (skew_z and divergence both read skew);
a sum overstates them, a mean understates independent confirmation. √m is the
compromise, and it is itself on trial in 5.6. Below 1 point it shows "—".

### 5.8 The projection is the market's distribution, labelled as such
The ticker page leads with the probability distribution option prices imply
(`projection.ts`): skew-aware (smile slope in the digital formula), centred on
the put-call-parity forward, per expiry. It is called market-implied /
risk-neutral everywhere it appears and is never blended with the learned
signals: the range answers "how far", the signal tilt (conviction) answers
"which way", side by side. **If reversed** (shifting the distribution by the
tilt, or presenting it as a forecast): a learned edge of a few points would be
dressed up as a price target, and the risk premium in option prices would be
read as real-world odds.

### 5.9 History adjustment shrinks toward "as priced"
Realized ÷ implied is measured per stock and sector over non-overlapping
periods and shrunk (sector → 1, stock → sector, k = 8 periods). The adjusted
range is shown beside, never instead of, the market's. **If reversed** (raw
per-stock ratios): a stock with three quiet months would show a range a third
the size the market prices, on no evidence.

### 5.10 Projections grade themselves
One logged projection per name per week (two horizons), graded at expiry with
the finalized close, versioned by method. Weekly, not daily: daily logging of
30-day ranges would be ~21× overlapping evidence for ~5× the storage. **If
removed**: the range would be unfalsifiable — exactly what 5.6 forbids for
convictions.

### 5.11 Relationships are exploratory and carry their sample sizes
Lead/lag correlations use overlap-adjusted t (n/10); analogs report their
base rate, Wilson interval and distance; all refuse thin samples. They inform,
they do not feed convictions: the signal grid stays fixed (4.3), so nothing
found here silently becomes a signal. A relationship worth trading becomes a
NEW signal type, logged and graded forward like the others.

### 5.12 Every number defines itself
`glossary.ts` is the one source for what each figure is, how it is computed,
how to read it and where it misleads; `<Term>` renders it on hover, focus or
tap, and the scanner headers append the same text. **If reversed** (ad-hoc
tooltips): definitions drift between pages.

### 5.13 Only this session's data is pinned at the close
`finalizeDailyCapture` pins a row only when its data is from the session being
captured (the same rule as the provisional rows and the capture guard). A
name the feed still serves from days ago — it stopped trading (AVB, EQR, QRVO,
WBD in October 2026), or its refresh kept failing — used to be pinned every
night with its old close, IV and skew: a ghost close the learning then had to
discard, and a stale value inside its sector's medians and every peer's
z-score. **If reversed:** dead names keep feeding sector statistics.

### 5.14 Sessions computed before their history existed are repaired
The sector z-scores need 20 (30-day) and 60 (90-day) earlier sessions. A new
database — the move to Aiven ran from Oct 14 with the history arriving only on
Nov 1 — computes every session until then with null z-scores, so the skew,
divergence and regime-break signals those sessions should have fired never
were. `repairThinRelativeDays` (daily pass, before grading) finds sessions
whose spread is stored but whose z is null although the 90 rows before them
now hold enough values, recomputes them oldest first from rows before each
session only (point-in-time), and logs the z-dependent signals they missed
(`createdAt` records that they were logged late; event badges come from live
state and are not rebuilt). Stored edge books are not rewritten: the
recovered signals enter the evidence of the books that follow. **If
reversed:** about three weeks of evidence is missing from the learning for
good.

### 5.15 Coverage is checked per stock, on the real database
The Learning page's coverage card (`learning-coverage.ts`,
`/api/learning/coverage`) shows, for every tracked stock, whether its data
reaches each stage — capture, options data, sector comparison, signal
learning, the projection check — as ready, warming up (arriving, not enough
yet) or a problem (data that should arrive does not: stopped updating, missing
sessions, incomplete options data, no peer group, z-scores not computed), with
a per-stock lookup. **Reasoning:** the learning's inputs are only as good as
the coverage behind them, and a gap in one stock is invisible in the
aggregate numbers.

### 5.16 Each name has its own daily clock (`intraday-profile.ts`)
"Volume vs expected" is session volume against what is normal BY THIS TIME OF
DAY. Until now that was one fixed U-shape for every name. It is now each
name's own profile: the share of the day's option volume it trades in each of
the 13 half hours, split into puts and calls, kept separately for regular
days, weekly-expiry days (the week's last session) and the session reacting
to its earnings.

- **Measured from the 5-minute snapshots, then folded.** Snapshots carry
  cumulative day volume; the curve is interpolated at each half-hour boundary.
  A session counts only when the curve reaches the close, no boundary sits in
  a gap longer than 75 minutes, and the day traded 200+ contracts; half days
  are skipped. Each finished session is folded once into a recency-weighted
  running sum (half-life 40 sessions of that kind) — 26 numbers per name per
  kind of day — because the snapshots are thinned after 5 days and a 1 GB
  database cannot keep them. The price: a changed method cannot be recomputed
  from history, so `CLOCK_METHOD` stamps the rows and a new method starts over.
- **Shrunk like everything else here.** fixed curve → all names → sector →
  name, each level weighted n / (n + prior) (10 sessions for a name). An
  expiry or earnings clock starts as the name's regular clock bent the way
  that kind of day bends its sector's, and moves to the name's own data as it
  arrives — a name has four earnings sessions a year, so on its own it would
  never have a clock for them.
- **Inside a half hour the expectation is interpolated**, not stepped to the
  end of the bucket as before (which understated the multiple early in every
  half hour). The first-half-hour floor stays: the opening minutes are judged
  against the whole first half hour, and never against less than 5% of a day.
- **The spike signal's definition moved with it.** Alerts — and so the
  `spike_alert` signal — are now relative to the name's own clock. The
  signal log's version stamp is NOT bumped: it is shared by every signal, and
  bumping it would discard all learned evidence to mark a refinement of one;
  the 120-session half-life lets the older spike evidence fade.

**If reversed:** names that always trade early alert every morning, names that
trade late never do, and every expiry Friday looks unusual.

### 5.17 Spike alerts are graded intraday, by time of day (`spike-outcomes.ts`)
An alert used to be graded on one number (the move about a day later). Each is
now graded on four windows — 30 minutes, 2 hours, that session's close, the
next session's close — and the results are learned per time of day (morning /
midday / afternoon) × lean (call- or put-heavy), for all names, each sector
and each name.

- **Windows start when the alert APPEARED**, not at the market moment that set
  it off: on the 15-minute-delayed feed the stretch in between could not have
  been acted on, so it is not credited.
- **Scored against SPY** for single names (the yardstick of §4.6), so a
  call-heavy spike on a day the whole market rallies gets no credit for the
  rally. ETFs are scored on their raw move, in a pool of their own.
- **Shrunk from a coin flip:** 50% → all names → sector → name, weight
  n / (n + prior) (30 / 40 / 40). Nothing is shown for a cell until 20 spikes
  of that kind are graded across all names. A name that re-alerts within one
  part of one session counts once. Observations halve in weight every 120
  sessions.
- **Graded in two steps** because the inputs expire at different times: the
  intraday windows as soon as the session ends (they need the 5-minute
  snapshots), the next-day window once that session has settled. An alert
  with no price on record near it is closed unmeasured and never learned from.
- **Live alerts quote the record** (`followThrough`): the name's own once it
  has 10 graded spikes of that kind, else its sector's (20), else all names'.
- Alerts are kept 400 days (was 120): graded alerts are the evidence.

**If reversed:** an alert says volume is unusual and nothing about what that
has meant at this hour.

### 5.18 Signal timing: the same book at three windows (`signal-timing.ts`)
The edge book grades every signal on one window, 10 sessions. Every graded
signal also has its 5- and 20-session returns on record, so each night the
latest book is rebuilt at all three windows — same evidence, same shrinkage,
each window against its own regime-matched base rate — and stored side by side
(`SignalTiming`, one row, replaced nightly). Comparing the three edges says
how long a signal has taken to work: fast and fading, slow to build, steady,
no edge, or pointing the wrong way.

- **Like for like.** A signal is graded at all three windows together, once
  its 20-session window has closed, so the three books rest on the same
  signals: a difference between windows is timing, not sample.
- **Picking the best of three flatters it, so the bar is explicit.** An edge
  must clear 2 points AND its own standard error; a window is named only when
  it beats the others by 1.5 points (or half the standard error); and a level
  needs 30 graded signals OF ITS OWN before any verdict. A stock's page reads
  the timing at the most specific level that has them — the stock, its sector,
  the market regime, all names — and says which.
- **Descriptive only.** The learned lean on the scanner stays on the
  10-session window, the one self-grading holds it to (§5.6). Letting each
  signal choose its own best window would be choosing after the fact, and
  would change what a year of graded convictions meant.
- **One load.** `loadLearningInputs` is split into the database read
  (`loadLearningRows`) and a pure per-window derivation, so the two extra
  windows cost no extra queries; they are derived one at a time because each
  holds every eligible stock-day.

**If reversed:** a signal with a real edge at 5 sessions and none at 10 reads
as "no edge", and nothing says how long to give a signal that has one.

### 5.19 The size of the move depends on conditions (`projection-history.ts`)
The realized ÷ implied ratio (§5.9) was one average per stock over every kind
of period. Three things known at a window's start change how big the move in
it runs against what was priced: the market's volatility regime (calm /
stressed), the stock's IV against its own recent median (high / low, from its
previous 20–120 sessions only), and whether it reports earnings inside the
window. For each, a factor — realized ÷ implied in that state over the pool's
usual — is learned on all names, then per sector, and the stock's blended
ratio is multiplied by the factors of the states it is in as of the latest
session. The adjusted range on the ticker page and the `calRatio` stored with
each logged projection use that conditional ratio, so the existing
projection grading (§5.10) tests it.

- **Pooled, not per stock.** One stock has a handful of independent periods in
  each state; a per-stock factor would be noise.
- **Evidence = independent periods OF THE STATE** (its distinct start dates ÷
  horizon). A thousand names on the same ten stressed sessions are two
  stressed weeks, not a thousand observations. So monthly factors stay near 1
  until months of each state exist; all names shrink toward 1, a sector
  toward all names (prior 8 periods), and a factor is bounded to 0.6–1.8.
- **Main effects only.** The three factors are multiplied as if independent;
  the joint cells (stressed × high IV × earnings) are far too thin to estimate.

**If reversed:** the same range multiplier is used the week a stock reports
in a stressed market as in a quiet week with nothing on the calendar.

### 5.20 Put/call against each name's own range: a second signal, not a replacement (`own-normal.ts`)
`pc_extreme` uses one band for every name (OI put/call ≥ 1.3 or ≤ 0.7), so a
stock that is hedged all year fires it every session and a retail favourite
fires the other side every session. `pc_own` asks the informative question
instead: is this session outside the name's OWN usual range — at or beyond
the 5th / 95th percentile of its previous 120 pinned sessions (40 minimum)?

- **Added beside `pc_extreme`, not in place of it.** Redefining the old
  signal would bump the shared `thresholdVersion` and discard every signal's
  learned evidence. As a new type, both definitions are graded on the same
  footing and the record shows which one carries an edge. The grid stays
  explicit about its size: the matrix reports cells tested and how many
  would clear by chance.
- **Cutoffs fixed in advance** (120 / 40 / p05–p95), stamped into every row's
  `detail` (`OWN_NORMAL.version`); a change is a new stamp, never a silent edit.
- **Point-in-time and reconstructible.** The percentile uses previous
  sessions only and is stored on the pinned row (`DailyMetric.oiPcPct`), so
  the base-rate denominator — days the signal could have fired — is exact
  (§4.4), and past sessions are filled from stored open interest with no
  hindsight. `repairOwnPutCall` logs the signals those sessions would have
  fired (dated on their session), so the new type starts with history.
- **Shown everywhere the fixed number is.** The scanner's OI P/C cell marks
  ▲ / ▼ when a name is outside its own range and its tooltip gives the range;
  the ticker page states where the live figure stands.

**If reversed:** the put/call signal keeps flagging the same structurally
put-heavy and call-heavy names every day.

### 5.21 One name, or its sector at once (`spike-outcomes.ts`, `sector-leaders.ts`)
**Breadth of a spike.** When an alert fires, the engine counts the names in
its sector that are spiking at that moment (this one included, among names
holding that session's data) and how many lean the same way. From 3 names and
8% of the sector it is "sector-wide", otherwise "one name"; the count is
stored on the alert (`sectorSpiking` / `sectorNames`), shown in the feed, and
lone and sector-wide spikes are graded apart (all times of day together,
single names only, shrunk from a coin flip, 20 graded before anything shows).
The cutoff was fixed before any result existed. ETFs have no breadth.

**Who leads whom.** The Cohorts page ranks, per cohort, the names whose
option positioning has shifted before the group moved: the rank correlation
between the day's change in a name's 25-delta risk-reversal skew and the
cohort benchmark's NEXT-session return in excess of SPY. A cohort has dozens
of names, so some correlate by luck: a name needs 40 sessions to be tested, is
listed only past |t| 2.6, and the card states how many names were tested and
how many would clear that bar by chance — and says so in words when the list
is no longer than that. Computed on demand per cohort and cached until the
next finalized session. **Exploratory by design:** it is daily, delayed and
one session ahead, so it ranks candidates and feeds nothing into the learned
lean.

**If reversed:** an alert cannot tell a stock-specific spike from a
sector-wide one, and nothing shows which names' flow tends to move first.

### 5.22 Signals together are measured, not assumed (`signal-combos.ts`)
The lean combines co-firing signals by a fixed rule (signed sum ÷ √m, §5.7).
Whether two signals agreeing on a name is actually worth more than either
alone is now measured: for every pair of signal types and each direction, the
edge on days both fired the same way, on days only the first fired, and on
days only the second fired — the same graded signals, regime-matched base
rates and recency weights as the edge book, built the same night and stored
beside the timing books (`SignalTiming.combos`).

- **The neutral guess is "company adds nothing".** The together edge is
  shrunk toward the average of the two alone edges (prior 40), not toward
  zero and not toward the better one — so a handful of co-firings cannot
  manufacture a synergy, and picking the better of two noisy numbers is not
  built into the baseline.
- **A verdict has to clear the better (or fall below the worse) alone edge**
  by 2 points and the together edge's own standard error, after 30 days
  together. Fifteen pairs in two directions are compared at once; the page
  says so.
- **The lean's rule is not changed.** It is the rule self-grading holds to
  account; the table shows what it assumes for each pair beside what was
  observed, which is the evidence a future change to it would need.

**If reversed:** "two signals agree" is treated as stronger evidence by rule,
with nothing checking whether it is.

---

## 6. Cross-cutting invariants (the short list a reviewer should protect)

1. Stored data is raw market fact; interpretation (inverse flips, labels)
   happens at the surface.
2. Only **finalized, non-seeded** rows feed any statistic; provisional, seeded,
   and close-only rows are structurally excluded.
3. History is **immutable**: finalized regime rows, emitted signals, closed
   episodes. Definition changes create a **new stamped version**
   (composition / weight method / regime config / thresholds / resolution
   method); no window or statistic spans versions unlabeled.
4. Missing data is refused, not fabricated: null-with-reason, warming states,
   suppression floors, γ-n/a buckets.
5. ET date boundaries everywhere; trading-day (not calendar-day) arithmetic for
   anything variance- or horizon-related.
6. External services are treated politely and defensively: throttles, declared
   identity, caching, backoff — the free-data constraint is a hard one.
7. Learning only weights the fixed signal grid; every learned number is
   point-in-time, shrunk on thin evidence, and graded against what happened.
8. Every chain-derived number carries the market time it reflects (`dataAsOf`);
   short-window figures are rates over measured data time, never sums over
   whatever happened to arrive.
9. A row's flow comes from one feed at a time and deltas never cross feeds;
   IV/skew/OI/GEX analytics come from the feed of record (CBOE) only — a
   second feed may contribute counts, never its own model-derived numbers.
10. Market-implied numbers are labelled risk-neutral, shown beside their own
   graded track record, and never mixed with learned direction; history
   adjustments shrink toward "as priced".