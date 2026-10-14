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

### 0.9 Outbound bytes: compact price ticks, compressed frames
Live-price sweeps push `[symbol, price, change%, time]` tuples (`quote-update`),
not full rows; socket frames over 1 KB are deflated; the full table is sent once
per connection (on the client's `request-snapshot`), not twice; the ticker page
reads its latest 100 snapshots, not 30 days of them every 15 s. **Reasoning:**
outbound traffic is what a host meters; resending every ~3 KB row each minute
to move one price was the largest stream. The Yahoo sweep covers the hot set
every minute and the whole universe every 5 minutes, keeping its request rate
near the old 552-name sweep.

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
