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
  only. No paid feeds, nothing scraped or flaky.
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

## 5. Cross-cutting invariants (the short list a reviewer should protect)

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
