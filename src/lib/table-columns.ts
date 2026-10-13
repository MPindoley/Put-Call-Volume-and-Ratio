/**
 * Scan-table column model: which columns exist, how wide they are, and which
 * to drop first when the table is narrower than all of them together.
 *
 * Why this exists: the full 17-column table needs ~1,356px. On a 1440px laptop
 * with the side panel open the table gets ~1,060px, and the old layout either
 * scrolled sideways or — worse — pushed the side panel off the screen. Instead
 * the table now drops its least important columns, in a fixed order, until it
 * fits. Nothing is removed for good: widen the window, collapse the side panel
 * or re-enable a column from the Columns menu and it comes back.
 *
 * Pure (no React) so the fitting rule is unit-tested.
 */

export type ColumnId =
  | 'symbol'
  | 'livePrice'
  | 'conviction'
  | 'putCallRatio'
  | 'putVolume'
  | 'callVolume'
  | 'netFlow'
  | 'premium'
  | 'iv30'
  | 'ivRank'
  | 'rrSkew'
  | 'oiPutCall'
  | 'skewZ30'
  | 'skewZ90'
  | 'spikeScore'
  | 'sparkline'
  | 'lastUpdated';

export interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Rendered width in px (matches the cell's Tailwind width class). */
  width: number;
  /**
   * Drop order when space runs out: higher drops first; columns sharing a value
   * drop together (Puts/Calls are a pair). 0 = never dropped automatically.
   */
  dropRank: number;
  /** Can the user hide it from the Columns menu? (Ticker cannot.) */
  hideable: boolean;
}

/** Display order. Widths mirror the cells: w-24=96, w-20=80, w-16=64, w-14=56, w-11=44, w-28=112. */
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { id: 'symbol', label: 'Ticker', width: 96, dropRank: 0, hideable: false },
  { id: 'livePrice', label: 'Last', width: 80, dropRank: 0, hideable: true },
  { id: 'conviction', label: 'Conv', width: 64, dropRank: 0, hideable: true },
  { id: 'putCallRatio', label: 'P/C', width: 56, dropRank: 0, hideable: true },
  { id: 'putVolume', label: 'Puts 5m', width: 64, dropRank: 6, hideable: true },
  { id: 'callVolume', label: 'Calls 5m', width: 64, dropRank: 6, hideable: true },
  { id: 'netFlow', label: 'Net Flow', width: 64, dropRank: 0, hideable: true },
  { id: 'premium', label: 'Prem 5m', width: 80, dropRank: 5, hideable: true },
  { id: 'iv30', label: 'IV30', width: 64, dropRank: 0, hideable: true },
  { id: 'ivRank', label: 'IVR', width: 44, dropRank: 4, hideable: true },
  { id: 'rrSkew', label: 'Skew', width: 56, dropRank: 1, hideable: true },
  { id: 'oiPutCall', label: 'OI P/C', width: 56, dropRank: 3, hideable: true },
  { id: 'skewZ30', label: 'zSkew30', width: 64, dropRank: 2, hideable: true },
  { id: 'skewZ90', label: 'zSkew90', width: 64, dropRank: 7, hideable: true },
  { id: 'spikeScore', label: 'Unusual', width: 112, dropRank: 0, hideable: true },
  { id: 'sparkline', label: 'P/C 30m', width: 112, dropRank: 8, hideable: true },
  { id: 'lastUpdated', label: 'Updated', width: 64, dropRank: 9, hideable: true },
];

/** Horizontal padding of a row (px-3 each side) and the gap between cells (gap-2). */
export const ROW_PADDING_X = 24;
export const CELL_GAP = 8;

export function rowWidth(ids: readonly ColumnId[]): number {
  if (ids.length === 0) return ROW_PADDING_X;
  const w = ids.reduce((s, id) => s + (COLUMN_DEFS.find((c) => c.id === id)?.width ?? 0), 0);
  return ROW_PADDING_X + w + CELL_GAP * (ids.length - 1);
}

export interface ColumnFit {
  /** Columns to render, in display order. */
  visible: ColumnId[];
  /** Columns dropped only for lack of space (not by the user). */
  droppedForSpace: ColumnId[];
}

/**
 * The columns to show in `availablePx`: everything the user has not hidden,
 * minus whole drop-rank groups (highest first) until the row fits. Columns
 * with dropRank 0 always stay, so on a very narrow screen the table may still
 * scroll sideways — but only then.
 */
export function fitColumns(availablePx: number, userHidden: ReadonlySet<ColumnId>): ColumnFit {
  const wanted = COLUMN_DEFS.filter((c) => !(c.hideable && userHidden.has(c.id)));
  const ranks = [...new Set(wanted.map((c) => c.dropRank).filter((r) => r > 0))].sort((a, b) => b - a);
  let keep = wanted;
  const dropped: ColumnId[] = [];
  for (const rank of ranks) {
    if (rowWidth(keep.map((c) => c.id)) <= availablePx) break;
    dropped.push(...keep.filter((c) => c.dropRank === rank).map((c) => c.id));
    keep = keep.filter((c) => c.dropRank !== rank);
  }
  return { visible: keep.map((c) => c.id), droppedForSpace: dropped };
}
