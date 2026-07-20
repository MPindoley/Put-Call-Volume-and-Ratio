import type { Sector } from '@/types';

/**
 * Tracked ticker universe (~450 optionable US names): S&P 500 core, heavily
 * traded NASDAQ/mid-cap/ADR names, index & sector ETFs. Every symbol has been
 * validated against the CBOE delayed-quotes feed; extend freely and re-run
 * `node scripts/validate-universe.mjs` after edits.
 *
 * Sector labels approximate GICS at the sector level. ETFs (including the
 * index benchmarks) live under the ETF pseudo-sector.
 */

/** Index benchmarks surfaced in the dashboard's benchmark strip. */
export const BENCHMARKS: { symbol: string; label: string }[] = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'NASDAQ-100' },
  { symbol: 'DIA', label: 'Dow 30' },
  { symbol: 'IWM', label: 'Russell 2000' },
];

const BY_SECTOR: Record<Sector, string[]> = {
  ETF: [
    'SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'TLT', 'GLD', 'SLV', 'HYG', 'ARKK',
    'XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB', 'XLC', 'XLRE',
    'KRE', 'XBI', 'GDX', 'USO', 'EEM', 'EFA', 'FXI', 'EWZ', 'TQQQ', 'SQQQ', 'SOXL',
  ],
  Technology: [
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'ADBE', 'ACN', 'CSCO',
    'INTC', 'IBM', 'QCOM', 'TXN', 'NOW', 'INTU', 'AMAT', 'MU', 'LRCX', 'ADI',
    'KLAC', 'PANW', 'SNPS', 'CDNS', 'CRWD', 'ANET', 'MRVL', 'FTNT', 'ADSK', 'NXPI',
    'MCHP', 'ON', 'HPQ', 'DELL', 'WDC', 'STX', 'SWKS', 'TER', 'ZBRA', 'EPAM',
    'AKAM', 'JNPR', 'FFIV', 'QRVO', 'ENPH', 'FSLR', 'SMCI', 'PLTR', 'ARM', 'TSM',
    'ASML', 'SNOW', 'DDOG', 'NET', 'ZS', 'OKTA', 'MDB', 'TEAM', 'TWLO', 'SHOP',
    'HUBS', 'WDAY', 'VEEV', 'DOCU', 'BILL', 'GDDY', 'MPWR', 'COHR', 'GFS', 'APP',
    'MSTR', 'MARA', 'RIOT', 'CLSK', 'IONQ', 'RGTI', 'QUBT', 'AI', 'SOUN', 'PATH',
    'U', 'GTLB', 'CFLT', 'ESTC', 'S', 'TDC', 'GEN', 'IT', 'CDW', 'CTSH',
  ],
  'Communication Services': [
    'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'TMUS', 'VZ', 'T', 'CHTR',
    'EA', 'TTWO', 'WBD', 'OMC', 'IPG', 'LYV', 'MTCH', 'FOXA', 'NWSA',
    'RBLX', 'SNAP', 'PINS', 'SPOT', 'ROKU', 'TTD', 'Z', 'RDDT', 'NTES', 'BIDU',
  ],
  Financials: [
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'SPGI', 'AXP',
    'C', 'BLK', 'SCHW', 'CB', 'PGR', 'ICE', 'CME', 'AON', 'USB',
    'PNC', 'COF', 'TFC', 'AIG', 'MET', 'PRU', 'AFL', 'ALL', 'TRV', 'BK',
    'STT', 'DFS', 'FITB', 'KEY', 'RF', 'CFG', 'HBAN', 'MTB', 'SYF', 'PYPL',
    'COIN', 'HOOD', 'SOFI', 'AFRM', 'UPST', 'ALLY', 'NU', 'KKR', 'APO', 'BX',
    'ARES', 'TROW', 'BEN', 'NDAQ', 'CBOE', 'MKTX', 'MSCI', 'FIS', 'FI', 'GPN',
    'RJF', 'LPLA', 'AMP', 'PFG', 'CINF', 'WRB', 'HIG', 'XYZ',
  ],
  Healthcare: [
    'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'PFE', 'AMGN',
    'ISRG', 'SYK', 'BSX', 'VRTX', 'GILD', 'MDT', 'REGN', 'BMY', 'CVS', 'CI',
    'ELV', 'ZTS', 'BDX', 'HCA', 'MCK', 'EW', 'A', 'IDXX', 'IQV', 'BIIB',
    'MRNA', 'DXCM', 'ALGN', 'CNC', 'HUM', 'BAX', 'ZBH', 'GEHC', 'RMD', 'MOH',
    'NVO', 'AZN', 'ILMN', 'EXAS', 'SRPT', 'NVAX', 'HIMS', 'TDOC', 'CAH', 'COR',
    'HOLX', 'MTD', 'WAT', 'PODD', 'STE', 'VTRS', 'OGN', 'DVA', 'UHS', 'CRL',
  ],
  'Consumer Discretionary': [
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
    'ORLY', 'MAR', 'GM', 'F', 'AZO', 'HLT', 'ROST', 'YUM', 'DHI', 'LEN',
    'EBAY', 'ULTA', 'DRI', 'BBY', 'EXPE', 'CCL', 'RCL', 'NCLH', 'LVS', 'MGM',
    'WYNN', 'DPZ', 'POOL', 'KMX', 'APTV', 'GRMN', 'TSCO', 'DECK', 'LULU',
    'ABNB', 'DASH', 'CVNA', 'GME', 'AMC', 'CHWY', 'ETSY', 'PTON', 'RIVN', 'LCID',
    'NIO', 'XPEV', 'LI', 'BABA', 'JD', 'PDD', 'SE', 'MELI', 'DKNG', 'PENN',
    'CZR', 'WING', 'CAVA', 'SHAK', 'CROX', 'TPR', 'RL', 'VFC', 'M',
    'KSS', 'ANF', 'AEO', 'FIVE', 'BURL', 'WSM', 'RH', 'TOL', 'PHM', 'KBH',
  ],
  'Consumer Staples': [
    'PG', 'COST', 'WMT', 'KO', 'PEP', 'PM', 'MDLZ', 'MO', 'CL', 'TGT',
    'KMB', 'GIS', 'STZ', 'SYY', 'KHC', 'HSY', 'KR', 'ADM', 'MNST', 'DG',
    'DLTR', 'EL', 'CHD', 'CLX', 'MKC', 'CAG', 'HRL', 'SJM', 'TSN',
    'CELH', 'KVUE', 'BF.B',
  ],
  Energy: [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'WMB',
    'KMI', 'HES', 'HAL', 'DVN', 'BKR', 'FANG', 'TRGP', 'OKE', 'APA', 'MRO',
    'LNG', 'EQT', 'CTRA', 'AR', 'RRC', 'ET', 'EPD', 'ENB', 'SU', 'CNQ',
    'CCJ', 'LEU',
  ],
  Industrials: [
    'CAT', 'UNP', 'GE', 'HON', 'RTX', 'UPS', 'BA', 'DE', 'LMT', 'ADP',
    'ETN', 'ITW', 'CSX', 'NOC', 'EMR', 'FDX', 'GD', 'NSC', 'MMM', 'PH',
    'CTAS', 'TT', 'CARR', 'PCAR', 'JCI', 'CMI', 'OTIS', 'ROK', 'FAST', 'PAYX',
    'AME', 'URI', 'DAL', 'UAL', 'LUV', 'AAL', 'WM', 'RSG', 'DOV', 'XYL',
    'UBER', 'LYFT', 'AXON', 'HWM', 'GEV', 'TDG', 'LHX', 'HEI', 'BWXT', 'ODFL',
    'XPO', 'JBHT', 'ALK', 'JBLU', 'MAS', 'BLDR', 'RKLB', 'ASTS', 'LUNR', 'VRT',
  ],
  Materials: [
    'LIN', 'SHW', 'APD', 'FCX', 'ECL', 'NEM', 'NUE', 'DOW', 'DD', 'PPG',
    'VMC', 'MLM', 'LYB', 'IFF', 'ALB', 'CE', 'CF', 'MOS', 'STLD', 'PKG',
    'AA', 'CLF', 'SCCO', 'AEM', 'KGC',
  ],
  Utilities: [
    'NEE', 'SO', 'DUK', 'CEG', 'SRE', 'AEP', 'D', 'PCG', 'EXC', 'XEL',
    'ED', 'PEG', 'WEC', 'AWK', 'DTE', 'ES', 'AEE', 'ETR', 'FE', 'PPL',
    'VST', 'NRG', 'TLN', 'OKLO', 'SMR',
  ],
  'Real Estate': [
    'PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'PSA', 'O', 'CCI', 'DLR', 'CBRE',
    'AVB', 'EQR', 'VTR', 'SBAC', 'WY', 'IRM', 'EXR', 'MAA', 'ARE', 'INVH',
    'VICI', 'HST',
  ],
  Unknown: [],
};

export interface UniverseEntry {
  symbol: string;
  sector: Sector;
}

const cap = Number(process.env.MAX_TICKERS ?? 600);

const seen = new Set<string>();
export const UNIVERSE: UniverseEntry[] = (
  Object.entries(BY_SECTOR) as [Sector, string[]][]
).flatMap(([sector, symbols]) =>
  symbols
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .map((symbol) => ({ symbol, sector })),
);

export const TRACKED_UNIVERSE: UniverseEntry[] = UNIVERSE.slice(0, cap);

const sectorMap = new Map(UNIVERSE.map((u) => [u.symbol, u.sector]));

export function sectorOf(symbol: string): Sector {
  return sectorMap.get(symbol) ?? 'Unknown';
}

export const SECTORS: Sector[] = (Object.keys(BY_SECTOR) as Sector[]).filter(
  (s) => s !== 'Unknown' && BY_SECTOR[s].length > 0,
);
