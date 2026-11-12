# UI constraints

The scan dashboard's original UI directives, written down here so a reviewer can
verify them (the review lane could not — they had never been documented). This
file is the canonical spec; where the code diverged, the divergence is noted and
the two named gaps have been implemented to match.

## Scan table (FlowTable)

1. **Column budget.** The scan table is a dense, single-glance grid; it carries a
   fixed, small column set (currently 17: Ticker, Last, Conv, P/C, Puts 5m,
   Calls 5m, Net Flow, Prem 5m, IV30, IVR, Skew, OI P/C, zSkew30, zSkew90,
   Unusual, P/C 30m, As of). New signals do not get new columns — they go to
   the ticker detail view or the right-panel tabs. Adding a column is a
   deliberate budget decision, not a default.
   *`Last` was added deliberately (15 → 16): it is not a signal but the
   reference every other column is read against, and it is the only column
   sourced from a live feed rather than the delayed chain.*
   *`Conv` was added deliberately (16 → 17): it is not a new signal either but
   the app's LEARNED verdict on the existing ones — each of the name's signals
   from the latest session weighted by how well that signal has actually worked
   (src/lib/learning.ts). It is placed up front because it summarises the
   columns to its right. Unlike the z-score columns it is printed (rule 3): it is
   sparse — only names with a signal that session — and it is the headline.
   "—" whenever there is no signal or the evidence nets to ~0 (rule 4).*
2. **One meaning per color.** Green = bullish / call-side, red = bearish /
   put-side, everywhere. Amber/`caution` = "needs attention / elevated" (spikes,
   unconfirmed catalysts). Slate/grey = neutral or muted. A color never carries a
   second, unrelated meaning in a different column.
3. **Z-scores as intensity, not printed numbers.** Sector-relative z-score cells
   (zSkew30/zSkew90) render as a **background-intensity block** — hue by sign
   (green bullish / red bearish, per rule 2), opacity scaled by |z| (saturating
   near |z| = 3) — with the **numeric value on hover** (title). A printed signed
   number in every cell is visual noise at 500 rows; the eye should read a heat
   column and hover only where it matters. *(Gap fixed this review — was printing
   `+2.4` etc.)*
4. **Warming / insufficient-history states are muted, never alarming.** A metric
   still accumulating shows a slate `—` (or "warming N/…"), not an error color.
   Absence of data is the correct state, styled as such. The `Last` column
   follows the same rule in a sharper form: with no live quote it shows `—`
   rather than borrowing the delayed chain price, and a quote older than 3
   minutes dims to slate instead of implying it is current. A price that claims
   to be live and is not is worse than no price.
4a. **Every row says when its data is from.** The `As of` column is the
   market time the row's option data reflects (the free feed runs 15 minutes
   behind, and a re-served snapshot can be older still), not when it was
   fetched; it dims when a row is much older than the feed's normal lag. The
   `5m` columns are per-5-minute RATES measured over the latest data (hover a
   cell for the minutes measured), so names refreshed at different speeds
   compare like for like.
5. **Sort, filter, pin, flash.** Columns are sortable; sector/flow filters and the
   top-bar ticker search narrow the set (an active search shows as a removable
   chip in the table toolbar, so a filtered table never passes for the full one);
   pinned tickers stay on top; a row flashes briefly on a significant net-flow
   change and then settles.
5a. **Columns fit the width; they never push the page sideways.** The budget
   above is the full set. When the table is narrower than all of it, columns
   drop in a fixed order, least important first — As of, P/C 30m, zSkew90,
   Puts 5m + Calls 5m (as a pair), Prem 5m, IVR, OI P/C, zSkew30, Skew
   (`src/lib/table-columns.ts`, unit-tested). Ticker, Last, Conv, P/C, Net Flow,
   IV30 and Unusual never drop automatically. The Columns menu lets a user hide
   any column except Ticker (remembered per browser) and marks the ones dropped
   for lack of room. Rows are 32px.

## Navigation & deep links

6. Every ticker is a **deep link**: `/ticker/{SYMBOL}` renders that name's detail
   (projection, flow, volatility & positioning, versus its sector, track
   record, event move, unusual moves, time of day, relationships, stored
   snapshots), and `/ticker/{SYMBOL}#track-record` opens that section on
   arrival. Symbols in the scan table and in panels link to it. The ticker page
   has a sticky header — breadcrumb (Scanner › sector › symbol; the sector
   filters the scanner), live price, activity, market cap, data age — and a bar
   that opens any section (open ones are lit) or opens and closes them all.
   The reading of the stock is the glance block under it (see below).
7. The scanner's side panel is **tabbed** (Market / Alerts / Regime / Leaders /
   Accuracy), collapsible, and remembers its tab and open state per browser.
   Market holds the detail behind the one-row market strip (intraday ratio vs
   SPY, sector ratios, IV-dispersion proxy, most-active heatmap). The Regime tab
   additionally honours `?demo=1` (guarded — see METRICS.md).
8. **One app shell on every page** (`src/components/shell/AppShell.tsx`): a top
   bar with the primary nav (Scanner `/`, Cohorts `/sectors`, Learning
   `/learning`) showing the current page, the ticker search, the data-status
   pill (fresh/stale, market session, feed — simulated data is always labelled),
   notifications and settings; a slim status footer (stream vs polling fallback,
   API budget, DB, shortcuts, CSV export). The shell owns the socket, snapshot,
   toasts and shortcuts, and links navigate client-side so the live stream
   survives page changes. No page carries its own back-link.

## Reading a page at a glance (stock, Learning, Cohorts)

The detail pages had grown to three or four screens of cards. They are built so
the answer is on the first screen and every detail is one click away.

1. **Glance block first.** A few plain sentences, then six tiles — answer first
   ("Call-heavy", "Expensive for it"), the numbers behind it second
   (`ui/glance.tsx`). The wording is pure and unit-tested
   (`lib/ticker-summary.ts`, `lib/learning-summary.ts`): a missing input reads
   "No data yet" and offers nothing to open, never a number; a pace that rounds
   to 0.0× is omitted, not printed. The sentence always covers the flow and the
   learned lean, then only what is outside the stock's own normal.
   Six tiles, because two, three or six to a row leaves no empty cell.
2. **Every card is a drop-down section** (`ui/collapsible.tsx`). The bar shows
   the title in a fixed column and the section's headline beside it, open or
   closed, so the closed page reads like a table. Sections start closed (the
   short Cohorts page starts open); what is open is remembered per browser
   (`ticker.sections`, `learning.sections`, `sectors.sections`) — per page, not
   per stock, so the layout you leave is the layout the next stock opens with.
   A card rendered directly inside a section drops its own frame and title
   (`EmbeddedContext`); `Standalone` restores them for cards shown side by side.
3. **Answer first, detail on request** (`ui/more-detail.tsx`). An open section
   leads with its reading; dense tables (odds by level, level-by-level
   estimates, individual analogs, audit columns) sit behind a remembered
   "Show …" control. Nothing is removed.
4. **Everything explains itself.** A dotted underline or the "?" beside a
   section title opens a definition from `lib/glossary.ts`: what it is, how it
   is worked out, how to read it, where it can mislead. The "?" explains and
   the rest of the bar toggles; a tile's label explains and the rest of the
   tile opens its section. One glossary, so a definition never drifts between
   pages. New numbers get a glossary entry, not a `title=` tooltip.
5. **Links open what they point at.** An in-page link (`#track-record`), a tile,
   the header's section names and a link arriving from another page all open
   the section, not just scroll to its closed bar.

## Quick look (scanner)

Clicking a scanner row — anywhere but the symbol link or the pin, which keep
their own jobs — puts that stock's glance block and section headlines in the
side column (`dashboard/QuickLook.tsx`); on a narrow screen it is a full-screen
sheet. `↑`/`↓` walk the visible rows, `Esc` closes. It reads the same payload as
the stock page (`hooks/useTickerDetail.ts`), so the page and the quick look
cannot disagree and opening the page afterwards starts from loaded data.
Alerts are two lines each (who, how big, which way, when; then breadth and
follow-through) with the rest behind an arrow; clicking one opens its quick look.

## Keyboard shortcuts

A global handler (mounted once in the app shell, so it works on every page) provides:

| Key | Action |
|-----|--------|
| `/` | focus the ticker search box |
| `↑` / `↓` | move through search matches; with a quick look open, through the scanner rows |
| `Enter` | open the highlighted ticker |
| `Esc` | clear + blur the search box; close the quick look |
| `?` | toggle the keyboard-shortcuts help overlay (also the footer's "Shortcuts") |

Shortcuts are suppressed while typing in an input/textarea (except `Esc`).
*(Gap fixed this review — there was no global handler before.)*

## Theme

Dark, terminal-adjacent; numeric columns use tabular figures (`tnum`) so digits
align. Density over decoration — this is a monitoring surface, not a marketing
page.
