/**
 * Synthetic options-flow generator, used when POLYGON_API_KEY is absent (demo
 * mode). Produces cumulative session volumes with realistic characteristics:
 * per-ticker liquidity tiers, intraday U-shape pacing, drifting put/call skew,
 * and occasional injected volume spikes so the detection pipeline can be
 * exercised end to end.
 */
import type { OptionsChainAggregate } from './polygon';
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
    };
  }
}
