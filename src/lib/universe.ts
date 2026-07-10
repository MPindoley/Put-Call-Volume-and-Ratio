import type { Sector } from '@/types';

/**
 * Tracked ticker universe: the most options-liquid S&P 500 constituents plus
 * the index ETFs used for aggregate context. Extend freely — the poller,
 * engine and UI all scale from this single list (MAX_TICKERS env caps it).
 *
 * Sector labels follow GICS at the sector level.
 */
const BY_SECTOR: Record<Sector, string[]> = {
  ETF: ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLK', 'XLE', 'XLV', 'SMH', 'TLT', 'GLD', 'HYG'],
  Technology: [
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'ADBE', 'ACN', 'CSCO',
    'INTC', 'IBM', 'QCOM', 'TXN', 'NOW', 'INTU', 'AMAT', 'MU', 'LRCX', 'ADI',
    'KLAC', 'PANW', 'SNPS', 'CDNS', 'CRWD', 'ANET', 'MRVL', 'FTNT', 'ADSK', 'NXPI',
    'MCHP', 'ON', 'HPQ', 'DELL', 'WDC', 'STX', 'SWKS', 'TER', 'ZBRA', 'EPAM',
    'AKAM', 'JNPR', 'FFIV', 'QRVO', 'ENPH', 'FSLR', 'SMCI', 'PLTR',
  ],
  'Communication Services': [
    'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'TMUS', 'VZ', 'T', 'CHTR',
    'EA', 'TTWO', 'WBD', 'OMC', 'IPG', 'LYV', 'MTCH', 'PARA', 'FOXA', 'NWSA',
  ],
  Financials: [
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'SPGI', 'AXP',
    'C', 'BLK', 'SCHW', 'CB', 'PGR', 'MMC', 'ICE', 'CME', 'AON', 'USB',
    'PNC', 'COF', 'TFC', 'AIG', 'MET', 'PRU', 'AFL', 'ALL', 'TRV', 'BK',
    'STT', 'DFS', 'FITB', 'KEY', 'RF', 'CFG', 'HBAN', 'MTB', 'SYF', 'PYPL',
  ],
  Healthcare: [
    'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'PFE', 'AMGN',
    'ISRG', 'SYK', 'BSX', 'VRTX', 'GILD', 'MDT', 'REGN', 'BMY', 'CVS', 'CI',
    'ELV', 'ZTS', 'BDX', 'HCA', 'MCK', 'EW', 'A', 'IDXX', 'IQV', 'BIIB',
    'MRNA', 'DXCM', 'ALGN', 'CNC', 'HUM', 'BAX', 'ZBH', 'GEHC', 'RMD', 'MOH',
  ],
  'Consumer Discretionary': [
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
    'ORLY', 'MAR', 'GM', 'F', 'AZO', 'HLT', 'ROST', 'YUM', 'DHI', 'LEN',
    'EBAY', 'ULTA', 'DRI', 'BBY', 'EXPE', 'CCL', 'RCL', 'NCLH', 'LVS', 'MGM',
    'WYNN', 'DPZ', 'POOL', 'KMX', 'APTV', 'GRMN', 'TSCO', 'DECK', 'LULU',
  ],
  'Consumer Staples': [
    'PG', 'COST', 'WMT', 'KO', 'PEP', 'PM', 'MDLZ', 'MO', 'CL', 'TGT',
    'KMB', 'GIS', 'STZ', 'SYY', 'KHC', 'HSY', 'KR', 'ADM', 'MNST', 'DG',
    'DLTR', 'EL', 'CHD', 'CLX', 'MKC', 'CAG', 'HRL', 'SJM', 'TSN', 'K',
  ],
  Energy: [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'WMB',
    'KMI', 'HES', 'HAL', 'DVN', 'BKR', 'FANG', 'TRGP', 'OKE', 'APA', 'MRO',
  ],
  Industrials: [
    'CAT', 'UNP', 'GE', 'HON', 'RTX', 'UPS', 'BA', 'DE', 'LMT', 'ADP',
    'ETN', 'ITW', 'CSX', 'NOC', 'EMR', 'FDX', 'GD', 'NSC', 'MMM', 'PH',
    'CTAS', 'TT', 'CARR', 'PCAR', 'JCI', 'CMI', 'OTIS', 'ROK', 'FAST', 'PAYX',
    'AME', 'URI', 'DAL', 'UAL', 'LUV', 'AAL', 'WM', 'RSG', 'DOV', 'XYL',
  ],
  Materials: [
    'LIN', 'SHW', 'APD', 'FCX', 'ECL', 'NEM', 'NUE', 'DOW', 'DD', 'PPG',
    'VMC', 'MLM', 'LYB', 'IFF', 'ALB', 'CE', 'CF', 'MOS', 'STLD', 'PKG',
  ],
  Utilities: [
    'NEE', 'SO', 'DUK', 'CEG', 'SRE', 'AEP', 'D', 'PCG', 'EXC', 'XEL',
    'ED', 'PEG', 'WEC', 'AWK', 'DTE', 'ES', 'AEE', 'ETR', 'FE', 'PPL',
  ],
  'Real Estate': [
    'PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'PSA', 'O', 'CCI', 'DLR', 'CBRE',
    'AVB', 'EQR', 'VTR', 'SBAC', 'WY', 'IRM', 'EXR', 'MAA', 'ARE', 'INVH',
  ],
  Unknown: [],
};

export interface UniverseEntry {
  symbol: string;
  sector: Sector;
}

const cap = Number(process.env.MAX_TICKERS ?? 250);

export const UNIVERSE: UniverseEntry[] = (
  Object.entries(BY_SECTOR) as [Sector, string[]][]
).flatMap(([sector, symbols]) => symbols.map((symbol) => ({ symbol, sector })));

export const TRACKED_UNIVERSE: UniverseEntry[] = UNIVERSE.slice(0, cap);

const sectorMap = new Map(UNIVERSE.map((u) => [u.symbol, u.sector]));

export function sectorOf(symbol: string): Sector {
  return sectorMap.get(symbol) ?? 'Unknown';
}

export const SECTORS: Sector[] = (Object.keys(BY_SECTOR) as Sector[]).filter(
  (s) => s !== 'Unknown' && BY_SECTOR[s].length > 0,
);
