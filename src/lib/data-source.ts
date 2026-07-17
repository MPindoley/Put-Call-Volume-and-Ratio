/**
 * Provider factory + shared API-usage stats for the status bar.
 * Returns null for demo mode (the poller then runs the simulator).
 */
import { CboeClient } from './cboe';
import { MassiveClient } from './massive';
import { resolveProviderChoice, type OptionsDataProvider } from './provider';

const globalStore = globalThis as unknown as { __dataProvider?: OptionsDataProvider | null };

export function getDataProvider(): OptionsDataProvider | null {
  if (globalStore.__dataProvider !== undefined) return globalStore.__dataProvider;
  const choice = resolveProviderChoice();
  let provider: OptionsDataProvider | null;
  switch (choice) {
    case 'massive':
      provider = new MassiveClient(
        process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY ?? '',
        Number(process.env.MASSIVE_RPM ?? process.env.POLYGON_RPM ?? 5),
      );
      break;
    case 'cboe':
      provider = new CboeClient(Number(process.env.CBOE_RPM ?? 60));
      break;
    case 'demo':
      provider = null;
      break;
  }
  globalStore.__dataProvider = provider;
  return provider;
}

export function apiStats(): { provider: string; callsLastMinute: number; perMinute: number } {
  const p = getDataProvider();
  if (!p) return { provider: 'simulator', callsLastMinute: 0, perMinute: 0 };
  return { provider: p.name, callsLastMinute: p.bucket.callsLastMinute(), perMinute: p.bucket.perMinute };
}
