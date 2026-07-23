# UI constraints

The scan dashboard's original UI directives, written down here so a reviewer can
verify them (the review lane could not — they had never been documented). This
file is the canonical spec; where the code diverged, the divergence is noted and
the two named gaps have been implemented to match.

## Scan table (FlowTable)

1. **Column budget.** The scan table is a dense, single-glance grid; it carries a
   fixed, small column set (currently 15: Ticker, P/C, Puts 5m, Calls 5m, Net
   Flow, Prem 5m, IV30, IVR, Skew, OI P/C, zSkew30, zSkew90, Unusual, P/C 30m,
   Updated). New signals do not get new columns — they go to the ticker detail
   view or the right-panel tabs. Adding a column is a deliberate budget decision,
   not a default.
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
   Absence of data is the correct state, styled as such.
5. **Sort, filter, pin, flash.** Columns are sortable; sector/flow filters and a
   ticker search narrow the set; pinned tickers stay on top; a row flashes briefly
   on a significant net-flow change and then settles.

## Navigation & deep links

6. Every ticker is a **deep link**: `/ticker/{SYMBOL}` renders that name's detail
   (volatility & positioning, sector-relative, event gauge, idiosyncratic feed,
   stored history). Ticker cells in the scan table and in panels link to it.
7. The right column is **tabbed** (Alerts / Accuracy / Regime / Leaders); the
   Regime tab additionally honours `?demo=1` (guarded — see METRICS.md).
8. `/sectors` is the cohort/sector overview. Back-links return to the scan.

## Keyboard shortcuts

A global handler (mounted once in `Dashboard`) provides:

| Key | Action |
|-----|--------|
| `/` | focus the ticker search box |
| `Esc` | clear + blur the search box |
| `?` | toggle the keyboard-shortcuts help overlay |

Shortcuts are suppressed while typing in an input/textarea (except `Esc`).
*(Gap fixed this review — there was no global handler before.)*

## Theme

Dark, terminal-adjacent; numeric columns use tabular figures (`tnum`) so digits
align. Density over decoration — this is a monitoring surface, not a marketing
page.
