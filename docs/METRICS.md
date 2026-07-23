# Metrics reference

Every derived metric the dashboard computes: what it is, how it's calculated,
how to read it, and where it lies to you. None of these is a trade signal on its
own — they're a sentiment mosaic. All thresholds referenced here live in the
`AnalyticsConfig` table (defaults in `src/lib/analytics-config.ts`), never
hardcoded in the math.

> **Structural skew offset (read this first).** Index and sector-ETF options
> carry a permanent put-skew bid because institutions hedge portfolios with
> index puts and overwrite calls. A single stock's raw skew therefore should
> **not** be read against zero — it should be read against its *sector*. That is
> the entire point of the Phase 1 sector-relative layer: a name whose skew is
> −3 looks bearish in isolation but is *neutral* if its sector median is also
> −3. Always prefer the relative z-scores over the absolute skew for sentiment.

---

## Core chain metrics (v5, per poll cycle)

### IV30 — 30-day implied volatility
The market's forecast of annualized volatility over ~30 days, read from the feed
(`iv30`). Raw IV means little alone — see IV Rank.
*Failure modes:* stale near the open before the chain populates; distorted by a
single wide bid/ask on illiquid names.

### IV Rank
Percentile of today's IV30 within the ticker's own accumulated IV30 history
(`ivRank(value, history)`, min 20 samples). 80 = IV is high for *this* name.
*Failure modes:* needs ≥20 stored days; a young database returns `—`. Not a true
52-week rank until ~1 year of history exists.

### HV20 — realized volatility
Annualized stdev of the last 20 daily log returns × √252, from CBOE's daily
history (`historicalVol`). Backfilled from 20-year history, so it's real day one.

### IV − HV spread
IV30 − HV20. Large positive = options pricing more movement than the stock has
recently delivered (fear/event premium). *Failure mode:* around earnings, IV is
*supposed* to exceed HV — not a mispricing.

### 25Δ risk reversal (skew)
IV(25Δ call) − IV(25Δ put) on the expiry nearest 30 DTE, in vol points
(`riskReversal25`). Negative = normal put skew; positive = calls bid over puts
(speculative upside chasing). This shows what people *pay*, not just what they
trade. *Failure modes:* hard-to-borrow names carry distorted put richness;
sparse 25Δ strikes on illiquid chains.

### Term structure & catalyst expiry
Near (~30 DTE) vs far (~90 DTE) ATM IV. Far < near = **backwardation**
(imminent-event fear). A single expiry whose ATM IV bulges ≥3 pts over both
neighbors is flagged as a **likely catalyst date** (earnings/FDA/legal).
*Failure mode:* thin far-dated quotes make the slope noisy.

### Implied move
ATM straddle of the nearest expiry ÷ spot, as ±%. The market's expected
magnitude by that expiry.

### OI P/C, OI change, max pain, OI walls, GEX, LEAP IV
Open-interest put/call ratio (positioning held, vs volume traded);
day-over-day OI change; the strike minimizing option-holder payout (max pain);
top-5 OI strikes (magnets near expiry); naive dealer gamma exposure (+ = dealers
dampen moves, − = amplify); long-dated ATM IV. *Failure mode:* **OI resets at
every expiration** — day-over-day OI change spikes are artifacts on expiry
Fridays, annotated as such on charts.

---

## Sector-relative layer (Phase 1, per end-of-day capture)

All of these are computed once per session at the **pinned end-of-day capture**
(close + feed delay, gated on the trading calendar), from **finalized rows
only**. Provisional intraday rows never enter a median or window.

### Cohorts (peer groups), median & benchmark
Relative analytics are computed per **cohort**, not per GICS sector. A cohort is
keyed by its **benchmark ETF**, and every tracked single name belongs to exactly
one: its per-ticker override if it has one (NVDA → SMH), else its GICS sector
SPDR (AAPL → XLK). **Membership is mutually exclusive — one name, one peer
group.** An overridden name leaves its GICS sector median entirely. For each
metric (IV30, skew, OI P/C, IV−HV): the median across the cohort's members (the
benchmark ETF is excluded) and the benchmark ETF's own value.

**`minConstituents` (default 5) is enforced AFTER override exits** — a cohort
thinned below the floor returns a **null** median rather than a thin one.

> **Technology (XLK) no longer means "all tech."** Once semis are overridden to
> SMH, XLK excludes them — the label reads "Technology (XLK)" but the peer set is
> tech *minus semiconductors*. Semis appear under "Semiconductors (SMH)". Read
> the cohort label, not the GICS sector name. (In a live run: XLK median IV fell
> from 72.6 to 66.5 when 12 semis moved to their own SMH cohort at median 89.)

**Membership filter** (which members *shape* the median; excluded names still get
a relative spread vs the cleaned median, and each exclusion is logged daily):
- **Liquidity floors** `medianMinOI` / `medianMinVolume` (0 = disabled).
- **IV outlier fence** `medianIqrMult` (default 2.5): members beyond
  Q1 − mult·IQR or Q3 + mult·IQR of the cohort IV distribution are excluded.
  *What it does NOT do:* it catches **sparse outliers**, not a genuinely wide
  cohort — so it (correctly) excludes nothing from a broad basket. Use cohort
  overrides, not a tighter fence, to separate genuinely distinct industry groups.

**Composition versioning.** Every cohort median and relative-spread row is
stamped with a `compositionVersion` = hash of the cohort's defined membership +
the membership-filter config. Rolling windows and percentiles filter to the
**current** version, so none ever spans two definitions: change the membership
(add an override, edit the universe, retune the filter) and that cohort's rolling
history **resets** and re-accumulates under the new definition — the "accumulating
N/90" counter drops accordingly. This mirrors the weighting-method stamp (which
instead *recomputes* the dispersion series, since reweighting the same members is
lossless). Per-cohort **member count** and **IV IQR** are recorded daily and
surfaced on the Cohorts page so you can tell whether a name's spread moved
because the name moved or because its cohort shifted.

### Relative spread & z-scores (z30 / z90)
`relSpread = ticker value − sector median`. Each spread is expressed as a
**guarded** z-score (`zScoreGuarded`) against its own finalized 30-day and
90-day rolling history:
- **Minimum-observation guard** `zMinObs30` / `zMinObs90` (defaults 20 / 60):
  below the minimum the z is **null** ("accumulating N/90"), never a number.
  This is the fix for the early-life blowup where a 1–2-row window with
  near-zero stdev produced spurious ±double-digit z's.
- **Stdev floor** `zStdevFloor` (default 0.1): the denominator is floored so a
  near-constant window can't blow the magnitude up. A tight-but-real
  distribution therefore yields a bounded z, not ±14.
- The **regime-detach flag cannot fire below the 90-day minimum** (it requires a
  non-null z90, which requires ≥ `zMinObs90` observations).

|z| ≥ 2 = a notable deviation from this name's own norm relative to its sector.
*Failure modes:* a flat window returns null (a z against zero dispersion is
undefined, not 0); early samples are labeled, not hidden.

### Regime-change detachment (◆ flag)
Fires when a relative metric's short-term (30-day) baseline has pulled away from
its long-term (90-day) baseline by more than `regimeDetachSigma` (default 1.0)
of the 90-day stdev, and both point the same way. Labeled with which metric
detached and the direction (widening/narrowing vs sector). This is the "quietly
loading / being distributed" tell. *Failure mode:* needs ~90 days to mean
anything; noisy on thin sectors.

### IV dispersion proxy
`benchmark-ETF IV30 ÷ weighted-average constituent IV30`, per sector.
- **Rising / high percentile** = macro/systemic regime (names move together,
  index vol rich vs components).
- **Falling / low percentile** = dispersion/stock-picking regime.

**Weighting cascade:** market-cap where every constituent has a configured cap
(`MarketCapConfig`), else OI-weighted, else equal-weighted. The method is
**stamped on every stored data point** (`dispersionWeightMethod`). A window or
percentile never mixes methods; if a sector's resolved method ever changes
(e.g. you populate caps), the **entire stored series for that sector is
recomputed** under the new method before any percentile is taken. Shown vs its
own 90-day percentile.

> **This is a proxy, not true implied correlation.** True implied correlation
> requires index-vs-constituent covariance structure and dividend/weight
> precision we don't have on the free feed. Read it as a dispersion *regime*
> gauge, not a tradeable correlation number.

### Equity-only vs ETF/index P/C
Aggregate P/C split by whether the underlying is a single name or an ETF/index.
Equity-only is the cleaner retail-sentiment read; ETF/index is dominated by
institutional hedging and reads differently (often contrarian at extremes).

### VIX term structure
VIX vs VIX3M (free CBOE index quotes). VIX above VIX3M = **backwardation**
(acute stress); steep contango = complacency.

---

## Direction- & inverse-aware interpretation (Phase 2)

Interpretation only — the raw stored values are never mutated.

### Inverse / leverage
Per-instrument config (`TickerOverride.inverse` / `.leverage`; defaults for
SQQQ 3×-inverse, TQQQ/SOXL 3×-long). For an **inverse** product the
interpretation is translated into *underlying-exposure* terms: a call-skew bid
on SQQQ colors **bearish** (bearish for the market it shorts), and a divergence
label flips distribution↔accumulation. Leverage is informational.

### IV-direction OI tiebreaker
Wherever OI change shows, it's paired with the **same-side** IV change to
classify intent, per side (calls and puts separately):

| OI | IV | Signal | Meaning |
|----|----|--------|---------|
| ↑ | ↑ | **demand** | new buyers paying up (buying pressure) |
| ↑ | ↓ | **supply** | new sellers / call overwriting |
| ↓ | ↓ | **unwind** | positions closing, vol bleeding |
| ↓ | ↑ | **short-cover** | closing buybacks / short cover |

Per-side IV change is **decomposed** from the underlying IV30 day-change and the
skew day-change (skew = callIV − putIV ⇒ d(callIV) ≈ dIV + dSkew/2,
d(putIV) ≈ dIV − dSkew/2) — no per-side IV feed needed. Moves within a deadband
(1% OI, 0.1 vol-pt IV) read flat.

> **This decomposition is an approximation, not a measurement.** It assumes the
> ATM change equals the average of the two wing changes; in reality the wings
> move independently of ATM, so a quadrant call driven by a large |dSkew|
> relative to |dIV| rests on a thin decomposition. The **raw dIV and dSkew are
> stored and shown** alongside every classification, and the UI flags a "thin
> decomposition" when |dSkew| > 2·|dIV|, so you can audit which side-calls to
> trust. For inverse products the sides are relabeled to underlying exposure
> (SQQQ calls → underlying puts), so demand on SQQQ calls reads as demand for
> downside.

### Divergence flag (▽ distribution / △ accumulation)
Compares the **20-day price-trend** sign against the **20-day trend of the
z-scored skew relative spread** (never the raw level — a structural offset like
AAPL's −43 IV normalizes away in the z, and a trend is offset-invariant besides).
Fires only when **both trends clear a t-stat screen** (|t| ≥ `divergenceTStat`,
default 1.5) and point in **opposite** directions:
- price **up** + skew-z **falling** (deteriorating) → **distribution warning**
  (rising into softening positioning — being distributed);
- price **down/flat** + skew-z **rising** (improving) → **accumulation warning**
  (weak price into strengthening positioning — quietly loading).

Needs ~40 finalized days to warm up (20 skew-z points, each needing ≥20 prior
obs); shows nothing until then. Inverse products flip the label to underlying
exposure.

> **The t-stat is a heuristic filter, not a significance test.** Overlapping
> daily observations are autocorrelated, so an OLS t-stat is inflated and 1.5 is
> not a real 87th-percentile threshold. Treat it as a screen that removes flat
> noise, nothing more. A **Newey-West (Bartlett-kernel HAC) t** — robust to that
> autocorrelation — is computed and **stored alongside** (`priceTrendTNW`,
> `skewTrendTNW`) and shown in the flag's tooltip, so you can see how much the
> OLS t was inflated and judge how many flags would survive a proper adjustment.
> The tooltip labels it accordingly.

*Other failure modes:* earnings can whipsaw the skew trend; a 20-day window
misses faster regime turns.

## Event variance decomposition (Phase 3, per poll cycle + daily)

Splits an expiry's total implied variance into an everyday **diffusive** piece and
a one-off **event** (earnings) jump, then reports the implied one-session event
move and ranks it against realized history.

### The model

For an expiry `i` with ATM implied vol `σ_i` (decimal, annualized) and time to
expiry `τ_i`, total implied variance to expiry is

```
V_i = σ_i² · τ_i = σ_d² · τ_i  +  v_e · 1{expiry i spans the event}
```

- `σ_d²` — annualized **diffusive** variance rate (ordinary day-to-day vol).
- `v_e` — the event's variance **lump**. It is *not* multiplied by time: the
  catalyst contributes its whole variance on the **single session** it is
  realized (guardrail 2). The implied one-session event move is `sqrt(v_e)`, a
  fraction of spot.

### Trading days, not calendar days (guardrail 2)

`τ_i = tradingDays_i / 252`, where `tradingDays` counts NYSE/CBOE **sessions**
from today to expiry (`tradingDaysBetween`, ET-anchored, weekends + holidays +
half days removed). Calendar days would attribute diffusion to weekends and
holidays where no trading — hence no diffusion — occurs, inflating `σ_d²` and
deflating the residual event variance. The event term itself is a single-session
lump and carries no `τ`.

### Two extraction brackets

Worked hand-example (also the unit test in `event-variance.test.ts`):
`eventIv = 0.60`, `refIv = 0.30`, event expiry `10` trading days out.

**A — pre-event reference.** An adjacent expiry that settles *before* the event
is clean diffusion, so `σ_d² = σ_ref²`. The adjacent expiry that spans the event
gives

```
τ_event = 10 / 252              = 0.0396825
σ_d²    = 0.30²                 = 0.09
v_e     = (σ_event² − σ_d²)·τ_event
        = (0.36 − 0.09)·0.0396825
        = 0.27 · 0.0396825      = 0.01071429
move    = sqrt(0.01071429)      = 0.10351  → ±10.35%
```

**B — two post-event.** With no clean pre-event expiry, use the two adjacent
expiries that both span the event and solve the 2×2 system:

```
σ_d² = (σ_near²·τ_near − σ_far²·τ_far) / (τ_near − τ_far)
v_e  =  σ_near²·τ_near − σ_d²·τ_near
```

### Expiry-pair selection (guardrail 3)

- **Adjacent bracketing expiries only.** Bracket A pairs the expiry immediately
  before the event with the one immediately after; bracket B pairs the two
  nearest post-event expiries. The selector never reaches past the adjacent pair.
- **Both must clear the liquidity floor** — configurable minimum ATM open
  interest (`eventMinOI`, default 100) and maximum ATM quote width as a fraction
  of mid (`eventMaxQuoteWidth`, default 0.25). Quote width comes from real
  bid/ask; when the ATM strike quotes no two-sided market it is treated as
  infinitely wide and fails the floor.
- If the adjacent pair fails the floor we **refuse to compute** rather than reach
  for a distant expiry whose diffusive vol genuinely differs.

### No clamping (guardrail 1)

A non-positive `v_e` returns **null with a logged reason**, never a zero clamp. A
near expiry priced below its neighbour for non-event reasons (thin quotes, a wide
spread, a stale side) produces this regularly; clamping would manufacture a
plausible small event move out of a data problem. The refusal reason is surfaced
on the ticker card, not hidden.

### Realized moves are timing-matched (guardrail 4)

The realized move must be measured on the session the implied definition refers
to, which depends on report timing:

- **`bmo`** (before open) → move over prior-close → event-date close.
- **`amc`** (after close) → move over event-date close → next-session close.
- **`intraday`** (rare mid-session release, EDGAR-derived) → measured on the bmo
  convention (last uninformed close → event-date close), not flagged.
- **`unknown`** → measured on the amc convention but flagged
  `realizedTimingUncertain` and **excluded from the rich/cheap statistic**.

EDGAR-sourced events derive timing from the filing's acceptance timestamp (see
below), so `unknown` should be rare — mainly manual entries without timing.

### Event sources — the calendar only

Earnings dates come from the calendar, in priority order. Price-history inference
does **not** produce earnings events — it can't separate earnings from product
launches, analyst days and headlines, and it misses quiet earnings — so it was
removed as a source and repurposed (see *Idiosyncratic-move feed* below).

1. **`manual`** — operator-entered ground truth; always confirmed.
2. **`edgar`** — SEC 8-K Item 2.02 filings, official ground truth (see below).
3. **`forward`** — the term-structure IV bulge identifies the expiry, the operator
   **confirms** the date, and the realized reaction is recorded going forward. A
   `confirmed=false` forward candidate does not count until confirmed; an EDGAR
   filing landing near it auto-confirms it in place.

Forward *scheduling* stays manual + bulge-identified — there is no reliable free
forward earnings calendar, and nothing flaky is wired in.

### SEC EDGAR earnings confirmation

Earnings results are furnished on a **Form 8-K under Item 2.02**. EDGAR is
official, free and reliable, so it is the ground-truth source for **confirmed
earnings history** and for auto-confirming a forward event after the company
reports. It is *not* a forward schedule (it's a filing record). Requires
`SEC_CONTACT_EMAIL`.

- **Report timing for free.** The filing's **acceptance timestamp** (not the
  filing date) is converted to ET (DST-aware) and classified: ≥16:00 ET → `amc`
  (reaction is the next session), <09:30 ET → `bmo` (that session), otherwise a
  rare `intraday` release (measured like `bmo`). This retires the
  timing-uncertain flag for EDGAR events, so they enter the rich/cheap statistic
  on the correct session automatically. The raw timestamp (`acceptedAt`) is stored
  for audit.
- **Quarterly cadence required.** Not every Item 2.02 is a quarterly report
  (preliminary results and guidance reuse the item). Walking filings in time, one
  is accepted (confirmed) only when it is ≥ `edgarMinSpacingDays` (default 45)
  after the last accepted; a too-soon filing is stored **`pendingReview`** for the
  operator, never silently dropped. This spacing rule also dedups; **8-K/A
  amendments are skipped entirely** so they can't create a duplicate event.
- **CIK mapping** uses the official `company_tickers.json`; CIK is stable across
  ticker changes. **Everything fetched is cached** (`EdgarCache`, TTL
  `edgarCacheTtlHours`) and requests are throttled (<10/s) with a declared
  User-Agent, so a priority-list backfill never re-hits SEC. Backfill runs for the
  configured `edgarTickers` priority list, once daily.

### Rich/cheap gauge — confirmed history only

Ranks the live implied event move against the distribution of **realized** moves
from **confirmed** events only (`percentileRank`; ≥70th = rich, ≤30th = cheap).

- **Suppressed** until `minConfirmedEvents` (default 8) confirmed events with
  realized moves exist. Below that it shows a plain **"insufficient confirmed
  history" (N/8)** state — no number. That is the correct outcome, not a failure:
  the distribution builds itself quarter by quarter from forward-confirmed
  reactions, plus any manual history backfill.
- Only events with a known realized move and `realizedTimingUncertain = false`
  are eligible.

### Idiosyncratic-move feed (its own feature, NOT an earnings source)

A per-ticker history of large **unscheduled** single-name moves, detected on the
benchmark-adjusted residual — deliberately separate from earnings and never fed
into the rich/cheap distribution.

- Each ticker is regressed on **SPY** over a rolling trailing window
  (`inferBetaWindow`); a session is flagged when its residual exceeds
  `inferMoveZ`·robust-σ of the residual series (MAD-based, stdev fallback). A
  market-wide day (an index gap where everything moves together) has a near-zero
  residual and is not flagged.
- **Benchmark note:** the **sector SPDR remains the correct benchmark for
  sector-relative sentiment** (the cohort layer). Residual detection uses **SPY
  specifically** because a mega-cap is a heavy weight in its own concentrated
  sector ETF, so the sector ETF absorbs the name's move and shrinks its residual;
  SPY (much smaller self-weight) recovers the move.
- Two supporting filters: **market-wide-day exclusion** (a date where ≥
  `breadthShare` of the universe moved ≥ `breadthMoveZ`·σ is a market event, not a
  company one) and a **minimum raw-move floor** (`inferMinMovePct`) that drops a
  large residual paired with a near-zero stock move — a benchmark artifact such as
  a holiday-misaligned close.

## Regime-conditional accuracy (Phase 4)

Extends the Accuracy view: every signal is scored conditional on the regime it
fired in. The original alert scoreboard is untouched and stays available.

### Daily regime state (4.1)

One immutable finalized `DailyRegime` row per trading day, three **binary**
dimensions → an 8-cell space:

- **vol** — contango / backwardation (VIX3M − VIX);
- **trend** — SPX above / below its 50-day (SPY closes as the SPX proxy — the
  dividend drift is immaterial to a 50-day cross);
- **gamma** — aggregate dealer-gamma sign across the tracked universe.

Deadband + persistence replace any ongoing "neutral" state: a raw value inside
the configurable band holds the prior state and clears any pending flip; the
opposite side must persist `regimePersistDays` (default 2) consecutive days
before the state changes. `neutral` exists **only at series initialization**,
before a state is first established. Raw inputs (`vixSpread`, `spxClose`,
`spx50ma`, `aggGex`, `gexBreadth`) are stored beside the classified states so
boundary proximity is auditable.

- **Gamma is NULL for backfilled dates** — it cannot be reconstructed without
  historical OI/IV and is never fabricated. Vol and trend are reconstructed from
  stored VIX/VIX3M and SPY closes. The full triple starts at live capture; older
  signals are 2-D and the matrix buckets them separately rather than dropping them.
- **Aggregate gamma is stored two ways**: the net summed GEX (classified on its
  sign — it can be dominated by a single large position) and **breadth** (share of
  tracked tickers with positive GEX, often the better read). Classification uses
  net sign for now. Both measure the **tracked universe**, not the whole market.
- Every row is stamped with `regimeConfigVersion` (hash of the deadband/
  persistence knobs); retuning them starts a new version rather than silently
  redefining history. **Finalized rows are immutable — never recomputed.**

### Signal log (4.2)

One immutable `SignalLog` row per (ticker, signal type, finalized session),
emitted at EOD only from **finalized, non-seeded** rows (never provisional), with
the regime triple at fire time and four version stamps (`compositionVersion`,
`weightMethod`, `regimeConfigVersion`, `thresholdVersion`). A logged signal is
never recomputed under later baselines.

The grid is **fixed** (fixed before looking at results). Directional matrix:
`divergence`, `skew_z` (|z30| ≥ `skewZExtreme`), `pc_extreme` (OI-based P/C
beyond `pcHigh`/`pcLow` — a volume-based P/C would be a NEW type),
`spike_alert`. Separate tracks: `event_badge` (rich/cheap), `backwardation`
(episodes), `regime_detach` (logged, magnitude analysis only). **Any future
signal type is reported separately, never folded into this matrix.**

**The directional matrix is single names only.** ETF/index put flow is
structurally hedging — the same reason the ratio panel splits equity from ETF —
so a put-heavy reading on SPY or HYG is not a bearish directional bet. Every
signal row carries an `isEtf` flag; ETF extremes are still logged for reference
but route to their own small panel (and are excluded from the base-rate
denominators too), never into the matrix.

The continuous **magnitude** (actual z, actual P/C, actual percentile) is stored
alongside every flag. Re-thresholding magnitudes after seeing outcomes is a form
of overfitting — any such analysis is exploratory only.

Non-fire days are reconstructible point-in-time: eligibility state is persisted
daily (`skewZ30`/`divergenceWindow` on RelativeMetric; `putOI`/`callOI`,
`spikeBaselineDays`, `termSlope` on DailyMetric), so the could-have-fired
denominator can always be rebuilt under a given `thresholdVersion`.

### Forward scoring (4.3)

Once **20 trading days** elapse, each signal's 5/10/20-day forward log returns
are filled three ways: raw, excess vs SPY, excess vs the ticker's sector
benchmark. **Hit is defined on the excess return** (a bullish signal that made
+2% while the market made +4% is not a hit); raw is an explicit toggle. Nothing
is scorable for ~a month after go-live — the UI shows "warming, N signals
logged, first scoring available on DATE", which is the correct state, not a
failure.

- `event_badge` has its own hit definition: **rich** predicts realized under
  implied, **cheap** predicts realized over implied; hit = realized landed on the
  predicted side, measured against the **unconditional undershoot base** (how
  often events undershoot implied regardless of badge — mid-percentile events are
  logged as `fair` to feed that base).
- `backwardation` signals are joined to their episode; on close the **primary
  resolution is the curve shape**, derived from the persisted term-structure
  components (`atmIvNear`/`atmIvFar`, with an iv30+slope proxy for episodes
  opened before components were stored): **`front_collapse`** — the near end fell
  to meet the back, the feared event passed — vs **`back_lift`** — the far end
  rose to meet the front, the fear repriced as durable. The outcome class
  (`realized_move` ≥5% cumulative | `iv_crush` ≥5 IV pts with a small move |
  `faded`) is kept as a **secondary** label. Every closed episode is stamped
  `resolutionMethod` — `components` (persisted atmIvNear/Far at both ends) or
  `proxy` (any end fell back to iv30+slope, i.e. episodes opened before
  components were captured) — and the resolution statistics carry the method
  split so the two never silently mix. Resolution type vs forward return is the
  analytical question.

### Conditional matrix (4.4)

Signal type × regime cell: hit rate, **excess over the regime-matched base rate
as the headline**, n, average forward return, Wilson CI. Cells under
`minCellSample` (default 20) are suppressed.

**Base rates are regime-matched**: each signal's no-skill probability is measured
over all days its ticker was *eligible* to fire that signal **within the same
regime cell** — signal or not — so the matrix doesn't just rediscover that stocks
behave differently in backwardation. Below `baseRateMinTickerDays` (default 60)
in-regime ticker-days, the ticker's **cohort is pooled** instead, and every cell
labels which denominator it used (`ticker` / `cohort` / `mixed`).

**Statistical honesty, in the payload not just the docs**: the matrix is labeled
exploratory (overlapping forward windows are autocorrelated), every cell carries
its n and Wilson CI, and the response reports `cellsTested` alongside
`expectedByChance` — the number of cells that would clear |z| ≥ 1.96 by chance
alone (α·cells). Only rows stamped with the current `thresholdVersion` and
`regimeConfigVersion` enter; excluded counts are reported. CSV export at
`/api/accuracy/regime?format=csv`.

The UI's populated-grid preview (`?demo=1`) is guarded by the SAME production
gate as the seed scripts (`assertSeedAllowed`): it returns 403 under
`NODE_ENV=production` and requires `ALLOW_SEED=1` elsewhere; every demo payload
is stamped `demo:true` and bannered.

## Data-provenance flags

- `final` / `capturedEt` — the pinned post-close snapshot. Only finalized rows
  feed medians, windows and "accumulating N/90" counts.
- `historicalCloseOnly` — a row backfilled from 20-year price history: `close`
  present, IV/skew/OI **null**. Used for HV and price-trend only; never treated
  as a full metric row.
- The trading calendar (`src/lib/trading-calendar.ts`) gates capture: no capture
  on holidays; capture at 1pm-close + delay on half days.
- `seeded` — synthetic test rows. The deployed capture path never sets it
  (schema default false); only local seed scripts do, and they refuse to run in
  production or without `ALLOW_SEED=1`. **Every** median, z-score, rolling window
  and percentile filters `seeded: false`, so even a stray seeded row could never
  enter a statistic. Purge with `npm run seed:purge` (covers DailyMetric,
  RelativeMetric, CohortDaily, EarningsEvent, IdiosyncraticEvent, DailyRegime,
  SignalLog, BackwardationEpisode). No seeded row can be produced by, or affect,
  the deployed database. The regime-matrix demo mode (`?demo=1`) sits behind the
  same guard.
- **Immutability**: finalized `DailyRegime` rows and emitted `SignalLog` rows are
  never recomputed or overwritten; knob changes start a new stamped version
  (`regimeConfigVersion` / `thresholdVersion`) instead of rewriting history.
- **Version stamps** — `compositionVersion` + `dispersionWeightMethod` (cohorts),
  `regimeConfigVersion` (deadband/persistence), `thresholdVersion` (signal
  cutoffs), `resolutionMethod` (episode classification path). No statistic mixes
  two versions of any of these without labeling it.

## Known cross-cutting failure modes

1. **Young history** — z-scores, IV rank, dispersion percentiles and regime
   flags all need weeks-to-months of finalized captures. They show `—` /
   "accumulating" rather than guessing.
2. **Earnings distortion** — IV, skew and IV−HV all inflate into earnings.
   Catalyst dates are now first-class (EarningsEvent: manual/EDGAR/forward);
   earnings-cleaned baselines that exclude the −7/+1-day window remain a future
   toggle (`earningsWindowBeforeDays`/`AfterDays` are already in config).
3. **Hard-to-borrow** — heavy borrow cost shows up as artificial put richness
   (skew) unrelated to sentiment.
4. **OI expiry resets** — OI drops to near-zero after monthly expiration; the
   day-over-day OI change is meaningless across that boundary.
5. **15-minute feed delay** — every value is ~15 min old; fine for
   session/positioning reads, not for sub-15-minute tactics.
6. **Universe scope** — aggregate gamma (net + breadth) and the market-wide-day
   breadth filter measure the *tracked universe*, not the whole market; a small
   `MAX_TICKERS` weakens both.
7. **Mega-cap self-weight** — a name that dominates its sector ETF has part of
   its own move absorbed by that benchmark; residual detection therefore uses SPY,
   while sector-relative sentiment correctly keeps the sector benchmark.
8. **Overlapping forward windows** — 5/10/20-day returns on signals fired days
   apart share sessions and are autocorrelated; the matrix is exploratory by
   construction and says so in its payload.
