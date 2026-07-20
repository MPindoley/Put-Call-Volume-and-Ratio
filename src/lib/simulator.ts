/**
 * Synthetic options-flow generator, used when DATA_PROVIDER=demo (works
 * offline). Produces cumulative session volumes with realistic characteristics:
 * per-ticker liquidity tiers, intraday U-shape pacing, drifting put/call skew,
 * and occasional injected volume spikes so the detection pipeline can be
 * exercised end to end.
 */
import type { OptionsChainAggregate } from './provider';
import { DEFAULT_INTRADAY_SHAPE } from './spike-detector';
import { tradingBucket } from './utils';

interface SimState {
  putVolume: number;
  callVolume: number;
  putPremium: number;
  callPremium: number;
  price: number;
  openPrice: number;
  dailyTarget: number;
  callSkew: number; // 0..1 share of volume that is calls
  spikeCyclesLeft: number;
  spikeMultiplier: number;
  iv30: number;
  ivRank: number;
  rrSkew: number;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function hashSymbol(symbol: string): number {
  let h = 2166136261;
  for (const ch of symbol) h = (h ^ ch.charCodeAt(0)) * 16777619;
  return h >>> 0;
}

export class FlowSimulator {
  private state = new Map<string, SimState>();

  private init(symbol: string): SimState {
    const rand = seededRandom(hashSymbol(symbol));
    const liquidityTier = rand(); // 0..1, stable per symbol
    const price = 20 + rand() * 480;
    const st: SimState = {
      putVolume: 0,
      callVolume: 0,
      putPremium: 0,
      callPremium: 0,
      price,
      openPrice: price,
      // Mega-liquid names (SPY-like) trade millions of contracts; tail names thousands.
      dailyTarget: Math.round(3_000 + liquidityTier ** 3 * 2_500_000),
      callSkew: 0.45 + rand() * 0.15,
      spikeCyclesLeft: 0,
      spikeMultiplier: 1,
      iv30: 18 + rand() * 55,
      ivRank: Math.round(rand() * 100),
      rrSkew: -6 + rand() * 8,
    };
    this.state.set(symbol, st);
    return st;
  }

  snapshot(symbol: string): OptionsChainAggregate {
    const st = this.state.get(symbol) ?? this.init(symbol);

    // Volume expected this cycle: daily target × bucket weight, split into
    // ~60 poll cycles per 30-min bucket, with noise.
    const bucket = tradingBucket();
    const bucketWeight = DEFAULT_INTRADAY_SHAPE[bucket] ?? 0.06;
    const perCycle = (st.dailyTarget * bucketWeight) / 60;

    // Occasionally ignite a sustained spike (institutional burst).
    if (st.spikeCyclesLeft <= 0 && Math.random() < 0.004) {
      st.spikeCyclesLeft = 4 + Math.floor(Math.random() * 10);
      st.spikeMultiplier = 3 + Math.random() * 15;
      // Spikes are usually directional — push skew hard one way.
      st.callSkew = Math.random() < 0.5 ? 0.15 + Math.random() * 0.15 : 0.7 + Math.random() * 0.15;
    }
    const spike = st.spikeCyclesLeft > 0 ? st.spikeMultiplier : 1;
    if (st.spikeCyclesLeft > 0) st.spikeCyclesLeft -= 1;

    const cycleVolume = Math.max(0, perCycle * spike * (0.5 + Math.random()));
    st.callSkew = Math.min(0.9, Math.max(0.1, st.callSkew + (Math.random() - 0.5) * 0.02));

    const callAdd = Math.round(cycleVolume * st.callSkew);
    const putAdd = Math.round(cycleVolume * (1 - st.callSkew));
    const avgOptionPrice = st.price * 0.02; // rough near-the-money mark
    st.callVolume += callAdd;
    st.putVolume += putAdd;
    st.callPremium += callAdd * avgOptionPrice * 100;
    st.putPremium += putAdd * avgOptionPrice * 100;
    st.price *= 1 + (Math.random() - 0.5) * 0.002 + (st.callSkew - 0.5) * 0.0008;

    // Vol surface drifts slowly; spikes push IV and skew around.
    st.iv30 = Math.max(10, Math.min(120, st.iv30 + (Math.random() - 0.5) * 0.6 + (spike > 1 ? 1.5 : 0)));
    st.rrSkew = Math.max(-15, Math.min(10, st.rrSkew + (Math.random() - 0.5) * 0.4 + (st.callSkew - 0.5) * 0.3));

    const totalOI = st.dailyTarget * 8;
    const putOI = Math.round(totalOI * (1 - st.callSkew) * (0.8 + Math.random() * 0.4));
    const callOI = Math.round(totalOI * st.callSkew * (0.8 + Math.random() * 0.4));
    const termSlope = spike > 1 ? -1.5 - Math.random() * 3 : 1 + Math.random() * 3;
    const strikeStep = Math.max(1, Math.round(st.price / 20));
    const atm = Math.round(st.price / strikeStep) * strikeStep;

    return {
      symbol,
      putVolume: st.putVolume,
      callVolume: st.callVolume,
      putPremium: st.putPremium,
      callPremium: st.callPremium,
      underlyingPrice: st.price,
      priceChangePct: (st.price / st.openPrice - 1) * 100,
      contractsSeen: 40 + Math.floor(Math.random() * 200),
      largestContractVolume: Math.round(cycleVolume * (0.05 + Math.random() * (spike > 1 ? 0.9 : 0.3))),
      iv30: Number(st.iv30.toFixed(1)),
      iv30Change: Number(((Math.random() - 0.5) * 2).toFixed(2)),
      analytics: {
        rrSkew25: Number(st.rrSkew.toFixed(2)),
        atmIvNear: Number((st.iv30 - termSlope / 2).toFixed(1)),
        atmIvFar: Number((st.iv30 + termSlope / 2).toFixed(1)),
        termSlope: Number(termSlope.toFixed(2)),
        backwardated: termSlope < -0.5,
        eventExpiry: spike > 1 ? new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10) : null,
        impliedMovePct: Number(((st.iv30 / 100) * Math.sqrt(14 / 365) * 100).toFixed(2)),
        putOI,
        callOI,
        oiPutCall: callOI > 0 ? Number((putOI / callOI).toFixed(3)) : null,
        maxPain: atm,
        topStrikes: [-2, -1, 0, 1, 2].map((k) => ({
          strike: atm + k * strikeStep,
          putOI: Math.round((putOI / 8) * (1 - Math.abs(k) * 0.25)),
          callOI: Math.round((callOI / 8) * (1 - Math.abs(k) * 0.25)),
        })),
        gexPer1Pct: Math.round((callOI - putOI) * st.price * 0.9),
        leapIv: Number((st.iv30 * 0.85).toFixed(1)),
        ivRank: st.ivRank,
        hv20: Number((st.iv30 * (0.7 + Math.random() * 0.4)).toFixed(1)),
      },
    };
  }
}
