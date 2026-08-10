/* Live check: the staleness guard must reject a frozen (delisted) snapshot
 * and still accept a live one. */
import { CboeClient } from '../src/lib/cboe';

async function main(): Promise<void> {
  const c = new CboeClient(60);
  for (const sym of ['AAPL', 'BK', 'DFS', 'SPY']) {
    try {
      const a = await c.getOptionsFlowSnapshot(sym);
      console.log(`${sym.padEnd(5)} ACCEPTED  px=${a.underlyingPrice}  contracts=${a.contracts?.length ?? 0}`);
    } catch (e) {
      console.log(`${sym.padEnd(5)} REJECTED  ${e instanceof Error ? e.message : e}`);
    }
  }
}
void main();
