import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, snapshotPayload, SNAPSHOT_VERSION } from './engine-snapshot';
import { FlowEngine } from './flow-engine';
import { sessionCoverage } from './history-jobs';
import type { OptionsChainAggregate } from './provider';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 14, 14, 0, 0); // 10:00 ET

function snap(symbol: string, asOfMin: number, put: number, call: number): OptionsChainAggregate {
  return {
    symbol,
    putVolume: put,
    callVolume: call,
    putPremium: put * 50,
    callPremium: call * 50,
    underlyingPrice: 100,
    priceChangePct: 0.5,
    contractsSeen: 10,
    largestContractVolume: 10,
    iv30: 30,
    iv30Change: 0.2,
    asOf: T0 + asOfMin * MIN,
  };
}

function liveEngine(): FlowEngine {
  const e = new FlowEngine();
  e.mode = 'live';
  e.ingest(snap('AAA', 0, 1_000, 2_000), T0 + 15 * MIN);
  e.ingest(snap('AAA', 5, 1_200, 2_300), T0 + 20 * MIN);
  e.ingest(snap('BBB', 3, 500, 400), T0 + 18 * MIN);
  e.finalizeCycle(T0 + 20 * MIN);
  return e;
}

describe('engine snapshot', () => {
  it('round-trips every row through gzip', async () => {
    const e = liveEngine();
    const bytes = await encodeSnapshot(snapshotPayload(e, T0 + 21 * MIN));
    const p = await decodeSnapshot(bytes);
    expect(p?.v).toBe(SNAPSHOT_VERSION);
    expect(p?.flows.map((f) => f.symbol).sort()).toEqual(['AAA', 'BBB']);
    expect(p?.flows.find((f) => f.symbol === 'AAA')?.putVolume).toBe(e.getFlow('AAA')?.putVolume);
    expect(p?.aggregate).not.toBeNull();
  });

  it('refuses bytes it cannot read rather than misreading them', async () => {
    expect(await decodeSnapshot(Buffer.from('not gzip'))).toBeNull();
    const other = await encodeSnapshot({ ...snapshotPayload(liveEngine()), v: SNAPSHOT_VERSION + 1 });
    expect(await decodeSnapshot(other)).toBeNull();
  });

  it('restores rows with their own data times, without clobbering live ones', async () => {
    const saved = (await decodeSnapshot(await encodeSnapshot(snapshotPayload(liveEngine()))))!;
    saved.flows = saved.flows.map((f) => (f.symbol === 'BBB' ? { ...f, realtime: true } : f));
    const fresh = new FlowEngine();
    fresh.mode = 'live';
    // A live row for AAA already arrived in this process: it must win.
    fresh.ingest(snap('AAA', 60, 9_000, 9_000), T0 + 75 * MIN);
    expect(fresh.restoreSnapshot(saved)).toBe(1);
    expect(fresh.getFlow('AAA')?.sessionPutVolume).toBe(9_000);
    const b = fresh.getFlow('BBB')!;
    expect(b.dataAsOf).toBe(T0 + 3 * MIN);
    expect(b.realtime).toBe(false); // the overlay is not live in a new process
    expect(fresh.getAggregate()).not.toBeNull();
    expect(fresh.latestDataAsOf()).toBe(T0 + 60 * MIN);
  });

  it('starts a fresh measurement window after a restore (no delta against an unseen snapshot)', async () => {
    const saved = (await decodeSnapshot(await encodeSnapshot(snapshotPayload(liveEngine()))))!;
    const fresh = new FlowEngine();
    fresh.mode = 'live';
    fresh.restoreSnapshot(saved);
    const row = fresh.ingest(snap('BBB', 40, 900, 700), T0 + 55 * MIN);
    expect(row.flowWindowMs).toBeNull();
    expect(row.sessionPutVolume).toBe(900);
  });
});

describe('end-of-day capture coverage', () => {
  it("counts only rows holding the given session's data", () => {
    const e = liveEngine();
    const today = new Date(Date.UTC(2026, 9, 14));
    const yesterday = new Date(Date.UTC(2026, 9, 13));
    expect(sessionCoverage(e.allFlows(), today)).toBe(2);
    expect(sessionCoverage(e.allFlows(), yesterday)).toBe(0);
  });
});
