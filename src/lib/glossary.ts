/**
 * Plain-language definitions for every number the site shows — what it is,
 * how it is computed, how to read it, and where it can mislead. Rendered by
 * <Term> (hover, focus or tap) on the ticker page and as header tooltips on
 * the scanner. One source, so a definition never drifts between pages.
 */
export interface GlossaryEntry {
  /** Display name. */
  term: string;
  /** What it is, in one or two sentences. */
  what: string;
  /** How it is computed. */
  how?: string;
  /** How to read it. */
  read?: string;
  /** Where it can mislead. */
  caveat?: string;
}

export const GLOSSARY = {
  // ── Flow ──
  putCallRatio: {
    term: 'Put/Call ratio',
    what: 'Put contracts traded divided by call contracts traded.',
    how: 'Over the latest measured window (a rate per 5 minutes); the session ratio until a window exists.',
    read: 'Above 1 = more puts than calls. Single stocks usually run 0.5–0.8; index ETFs run higher because they are used for hedging.',
    caveat: 'Volume counts every trade — buys and sells, opening and closing — so a high ratio is not automatically bearish.',
  },
  putsCalls5m: {
    term: 'Puts / calls per 5m',
    what: 'Option contracts traded per 5 minutes, measured over the most recent stretch of data, then the session total.',
    how: 'Change in session volume between two snapshots ÷ the market time between them × 5 minutes.',
    read: 'Comparable across names refreshed at different speeds, because it is a rate.',
  },
  premium5m: {
    term: 'Premium per 5m',
    what: 'Dollars spent on options per 5 minutes.',
    how: 'Σ contract mid-price × contracts × 100, over the measured window.',
    read: 'Separates big-money flow from many cheap contracts.',
  },
  netFlow: {
    term: 'Net flow',
    what: 'Calls minus puts traded per 5 minutes.',
    read: 'Positive = call-heavy trading, negative = put-heavy.',
    caveat: 'Does not know whether the trades were buys or sells.',
  },
  volVsExpected: {
    term: 'Volume vs expected',
    what: "Today's option volume so far divided by what is normal for this name by this time of day.",
    how: '20-day average daily volume × the share of a day usually traded by now (intraday shape).',
    read: '1.0× = normal; 3× or more is unusual activity.',
  },
  chainPrice: {
    term: 'Chain price',
    what: 'The stock price inside the option snapshot the analytics were computed from.',
    caveat: 'On the free feed this is 15 minutes old; the live price is shown separately in the header.',
  },
  dataAsOf: {
    term: 'Data as of',
    what: 'The market time the option data reflects — not when it was fetched.',
    read: 'The free CBOE feed runs about 15 minutes behind; real-time (Schwab) rows are current.',
  },
  unusual: {
    term: 'Unusual score',
    what: '0–100 score of how abnormal the option activity is, with a level: elevated above 2× expected volume, significant above 5×, extreme above 10×.',
    how: '55% volume vs expected (full marks at 10×) + 25% premium in the window (full at $5M) + 20% how lopsided the put/call ratio is (full at 5:1 either way).',
    caveat: 'An alert also needs the minimum premium and contracts, and two confirming refreshes in a row.',
  },
  conviction: {
    term: 'Conviction',
    what: "What the app has learned about today's signals for this stock: points above the base rate of beating SPY over 10 sessions.",
    how: 'Each firing signal\'s learned edge (shrunk toward zero on thin evidence), signed and combined as sum ÷ √(count), capped at 25 points.',
    read: '+4 = historically ~4 percentage points more likely than normal to beat SPY. "—" = nothing meaningful firing.',
    caveat: 'A statement about past frequencies, not a promise.',
  },
  livePrice: {
    term: 'Live price',
    what: 'The latest traded stock price from the quote sweep (or the real-time chain).',
  },

  // ── Volatility & positioning ──
  iv30: {
    term: 'IV30',
    what: 'The 30-day implied volatility: the size of moves option prices are built on, as an annual percentage.',
    read: 'Divide by 16 for a typical daily move (IV 32 ≈ 2% a day); divide by 3.5 for a typical month (≈ 9%).',
  },
  ivRank: {
    term: 'IV rank',
    what: "Where today's IV30 sits within its own past year, 0 (lowest) to 100 (highest).",
    how: "Percentile of today's IV30 among stored daily IV30 values.",
    read: 'High = options expensive by this stock\'s own standard; low = cheap.',
    caveat: 'Needs 20+ stored sessions; it matures toward a full year as history builds.',
  },
  hv20: {
    term: 'HV20',
    what: 'How much the stock actually moved over the last 20 sessions, annualized like IV.',
    how: 'Standard deviation of daily log returns × √252.',
  },
  ivHvSpread: {
    term: 'IV − HV',
    what: 'Implied volatility minus recent realized volatility: the volatility premium.',
    read: 'Positive = options price bigger moves than the stock has been making. Usually positive; very large = fear or an expected event.',
  },
  rrSkew: {
    term: '25Δ risk reversal (skew)',
    what: 'How expensive upside calls are relative to downside puts, at about 30 days.',
    how: 'IV of the 25-delta call − IV of the 25-delta put, in volatility points.',
    read: 'Negative is normal (protection costs more). Rising toward zero or positive = demand for upside; falling = demand for protection.',
  },
  termSlope: {
    term: 'Term structure (slope)',
    what: 'Longer-dated vs shorter-dated implied volatility.',
    how: 'ATM IV at ~90 days − ATM IV at ~30 days.',
    read: 'Positive (contango) is normal. Negative (backwardation) = near-term stress or a known event priced in.',
  },
  impliedMove: {
    term: 'Implied move',
    what: 'The move the nearest expiry prices in.',
    how: 'At-the-money straddle (call + put) price ÷ stock price.',
    read: 'Roughly the expected absolute move by that expiry.',
  },
  eventExpiry: {
    term: 'Likely catalyst expiry',
    what: 'An expiry whose implied volatility pops above both neighbours — usually earnings or another dated event.',
    how: 'ATM IV at least 3 points above the expiries before and after it, within 60 days.',
  },
  oiPutCall: {
    term: 'OI put/call',
    what: 'Open puts divided by open calls: positions held, not just traded today.',
    read: 'Slower-moving than the volume ratio; shows where positioning has built up.',
  },
  oiChange: {
    term: 'OI change (day)',
    what: 'Day-over-day change in total open interest.',
    read: 'Rising = new positions opening; falling = positions closing.',
  },
  maxPain: {
    term: 'Max pain',
    what: 'The settlement price at which option holders would collect the least, at the nearest monthly expiry.',
    caveat: 'A popular but weak "magnet" theory; useful mainly as a reference level near expiry.',
  },
  gex: {
    term: 'Dealer gamma (est.)',
    what: 'Estimated dollars of stock dealers must trade per 1% move to stay hedged.',
    how: 'Σ gamma × open interest × 100 × price² × 1%, calls counted +, puts − (the usual assumption: customers mostly sell calls and buy puts).',
    read: 'Positive = dealer hedging tends to dampen moves; negative = it tends to amplify them.',
    caveat: 'A naive estimate: who is actually long or short each contract is not public.',
  },
  leapIv: {
    term: 'LEAP IV',
    what: 'Implied volatility of the longest-dated (about one year) options.',
    read: 'The market\'s long-run volatility; near-term IV well above it signals temporary stress.',
  },
  oiWalls: {
    term: 'Open-interest walls',
    what: 'The strikes with the most open contracts.',
    read: 'Large call walls above and put walls below often act as resistance and support into expiry.',
  },
  oiFlow: {
    term: 'OI flow',
    what: "Today's change in open interest paired with the same side's IV change.",
    read: 'Demand = OI up + IV up (buyers paying up). Supply = OI up + IV down (sellers). Unwind = OI down + IV down. Short cover = OI down + IV up.',
    caveat: 'Per-side IV is approximated from overall IV and skew changes.',
  },

  // ── Sector-relative ──
  zScore: {
    term: 'z-score (30 / 90 day)',
    what: "How unusual today's gap to the sector is compared with this stock's own recent history.",
    how: '(stock − sector median) today, minus its 30- or 90-day average, ÷ its standard deviation.',
    read: '0 = normal for this stock. |z| ≥ 2 is a notable deviation.',
  },
  skewZ: {
    term: 'Skew vs sector (z)',
    what: "Is this stock's skew unusually call-rich or put-rich relative to its sector, by its own standard?",
    read: 'Positive = calls richer than usual vs sector (bullish lean); negative = puts richer (defensive).',
  },
  ivZ: {
    term: 'IV vs sector (z)',
    what: "This stock's implied volatility relative to its sector, against its own history.",
    read: 'Positive = more fear/expected movement than usual vs peers.',
  },
  oiPcZ: {
    term: 'OI put/call vs sector (z)',
    what: "This stock's put/call open interest relative to its sector, against its own history.",
    read: 'Positive = more put-heavy positioning than usual vs peers.',
  },
  ivHvZ: {
    term: 'Vol premium vs sector (z)',
    what: "This stock's IV − HV spread relative to its sector, against its own history.",
    read: 'Positive = options unusually expensive vs realized moves, compared with peers.',
  },
  divergence: {
    term: 'Divergence',
    what: 'Price and options positioning trending in opposite directions over recent weeks.',
    read: 'Distribution = price up while skew deteriorates; accumulation = price down/flat while skew improves.',
    caveat: 'A heuristic screen; the HAC t-statistics on hover are the audit.',
  },

  // ── Learning ──
  learnedEdge: {
    term: 'Learned edge',
    what: 'How much more often than normal a signal has been followed by the stock beating SPY over 10 sessions.',
    how: 'Hit rate − regime-matched base rate, shrunk step by step (all names → market regime → sector → this stock) so thin samples count little.',
  },
  baseRate: {
    term: 'Base rate',
    what: 'How often stocks beat SPY in a given direction over 10 sessions with no signal, in the same market regime.',
    read: 'The "luck" line every signal is measured against.',
  },
  evidenceWeight: {
    term: 'Evidence weight',
    what: "How far a level's own data was allowed to move the estimate from the level above.",
    how: 'n ÷ (n + k), with k between 40 and 80 depending on the level.',
  },

  // ── Projection ──
  projection: {
    term: 'Projection',
    what: 'The probability distribution for the stock price at each expiry that option prices imply.',
    how: 'From the volatility smile: P(price > K) = N(d2) − φ(d2)·√T·dσ/dk, centred on the put-call-parity forward.',
    read: 'Mathematics on traded prices — not a forecast. It says how far the market prices moves, and how lopsided.',
    caveat: 'Risk-neutral: it includes what traders pay for protection, so it usually overstates real moves. See the history check.',
  },
  forward: {
    term: 'Forward',
    what: 'The price the options market centres its distribution on for that date.',
    how: 'From put-call parity at the strikes where calls and puts cost about the same: K + (call − put)·e^{rT}.',
    read: 'Slightly above spot normally (interest), below it when a dividend is due.',
  },
  range68: {
    term: '68% range',
    what: 'The price band the market prices as containing the stock at that expiry about 68% of the time.',
    how: '16th to 84th percentile of the implied distribution (one standard deviation either side, for a bell curve).',
  },
  range95: {
    term: '95% range',
    what: 'The band priced to contain the stock about 95% of the time.',
    how: '2.5th to 97.5th percentile of the implied distribution.',
  },
  medianPrice: {
    term: 'Middle (median)',
    what: 'The price with equal implied odds of finishing above or below.',
    read: 'Sits above the forward when downside puts are expensive: a few large drops are priced, balanced by more small gains.',
  },
  probAbove: {
    term: 'Chance of closing above',
    what: 'The implied probability the stock finishes above a price at that expiry.',
    caveat: 'Risk-neutral odds; compare with the history check before treating them as real-world odds.',
  },
  probTouch: {
    term: 'Chance of touching',
    what: 'Rough odds the price trades at that level at any point before expiry.',
    how: '≈ 2 × the chance of finishing beyond it (reflection principle).',
    caveat: 'An approximation: ignores skew and drift; best near the money.',
  },
  smileMethod: {
    term: 'Skew-aware',
    what: 'Whether the distribution used the full volatility smile (skew-aware) or a single at-the-money volatility (flat, when too few quotes).',
  },
  calibrationRatio: {
    term: 'Realized ÷ implied',
    what: 'How large actual moves have been compared with what IV30 priced at the time.',
    how: 'Root-mean-square of (actual log move ÷ implied move) over past windows; this stock shrunk toward its sector, the sector toward 1.',
    read: 'Below 1 = options usually overprice this stock\'s moves (common); above 1 = moves have been bigger than priced.',
    caveat: 'Windows overlap; "periods" counts the independent ones.',
  },
  adjustedRange: {
    term: 'History-adjusted range',
    what: 'The implied range rescaled by how real moves have compared with implied ones for this stock and sector.',
    how: 'Each bound\'s distance from the forward (in log terms) × the realized ÷ implied ratio.',
  },
  coverage: {
    term: 'Projection track record',
    what: 'How often the price actually finished inside the logged ranges.',
    how: 'One projection per name per week (~7 and ~30 days), graded with the settled close at expiry.',
    read: 'A well-calibrated 68% range contains the outcome about 68% of the time.',
  },
  callWall: {
    term: 'Call wall',
    what: 'The strike with the most call open interest (expiries within 60 days, within ±25% of the price).',
    read: 'Often acts as resistance as expiry approaches.',
  },
  putWall: {
    term: 'Put wall',
    what: 'The strike with the most put open interest (same window).',
    read: 'Often acts as support as expiry approaches.',
  },
  gammaFlip: {
    term: 'Gamma flip',
    what: 'The price where estimated dealer gamma changes sign.',
    how: 'Black–Scholes gamma of every contract out to 120 days re-evaluated across ±20% of the price; the zero crossing nearest the price.',
    read: 'Above it hedging tends to steady the stock; below it, to amplify moves.',
    caveat: 'Uses the same naive dealer-positioning assumption as dealer gamma.',
  },
  tilt: {
    term: 'Signal tilt',
    what: "Which way today's signals lean, and how much history says that lean is worth.",
    read: 'Shown separately from the range: the options market prices how far, the learned signals speak to which way.',
  },

  // ── Relationships ──
  spearman: {
    term: 'Correlation (ρ)',
    what: 'Spearman rank correlation, −1 to +1: do higher values of one measure tend to come with higher (or lower) values of the other?',
    read: '±0.1 is weak but can matter over many days; ±0.3 is strong for markets. Sign gives the direction.',
    caveat: 'Correlation is not cause.',
  },
  leadT: {
    term: 't (overlap-adjusted)',
    what: 'How confidently the correlation differs from zero.',
    how: 'ρ·√((n_eff − 2)/(1 − ρ²)) with n_eff = n ÷ 10, because 10-session windows overlap day to day.',
    read: '|t| ≥ 2 is marked notable.',
  },
  topBottomFifth: {
    term: 'Top / bottom fifth',
    what: 'How often the stock beat SPY over the next 10 sessions when this measure was in its highest 20% of days vs its lowest 20%.',
    read: 'A big gap between the two is the plain-language version of a strong correlation.',
  },
  coMovement: {
    term: 'Moves together',
    what: 'Rank correlations between the DAILY CHANGES of each pair of measures, and with the stock\'s same-day move vs SPY.',
    read: 'Blue = tend to rise together; red = one rises when the other falls.',
  },
  analogs: {
    term: 'Similar past setups',
    what: "Past sessions (this stock and its sector peers) whose measurements sat closest to today's, and what followed.",
    how: 'Distance = root-mean-square gap across the measurements in robust standard units, +0.5 per differing market-regime dimension; one per stock per 10-session episode.',
    read: 'Compare the beat rate with the base rate: the gap is what the resemblance has been worth.',
    caveat: 'Exploratory; similar setups are not identical, and history grows more useful as it accumulates.',
  },
  analogDistance: {
    term: 'Distance',
    what: 'How different a past session was from today, in robust standard deviations averaged across measurements.',
    read: 'Below 0.5 = very similar; above 1.5 = only loosely alike.',
  },
  ivRankFeature: {
    term: 'IV rank',
    what: "Today's IV30 percentile within the trailing year (as of each day).",
  },
  volRatio: {
    term: 'Option volume vs normal',
    what: "The day's option volume divided by its trailing 20-session median.",
  },
  mom5: {
    term: '5-day move vs SPY',
    what: "The stock's log return over the last 5 sessions minus SPY's.",
  },
  excess10: {
    term: 'Next 10 sessions vs SPY',
    what: "The stock's log return over the following 10 sessions minus SPY's.",
    read: 'Positive = the stock beat the market.',
  },

  // ── Event ──
  impliedEventMove: {
    term: 'Implied event move',
    what: 'The move priced for the catalyst itself, separated from normal day-to-day volatility.',
    how: 'Variance decomposition across expiries before and after the event.',
  },
  diffusiveVol: {
    term: 'Clean diffusive vol',
    what: 'The everyday volatility left once the event is taken out.',
  },
  richCheap: {
    term: 'Rich / cheap',
    what: "Today's implied event move against this stock's confirmed past event moves.",
    read: 'RICH = priced above most past reactions; CHEAP = below.',
  },
  residualZ: {
    term: 'Residual σ',
    what: 'How large a move was after removing what SPY explained, in standard deviations of such residuals.',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

/** Plain text for a native tooltip (scanner headers). */
export function glossaryTitle(key: GlossaryKey): string {
  const e: GlossaryEntry = GLOSSARY[key];
  return [`${e.term}: ${e.what}`, e.how && `How: ${e.how}`, e.read && `Read: ${e.read}`].filter(Boolean).join('\n');
}
