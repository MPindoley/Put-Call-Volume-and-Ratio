'use client';

/**
 * Data sources: where the numbers come from, and the owner's Schwab connection
 * (schwab-auth.ts) — connect, see when the weekly sign-in runs out, reconnect,
 * disconnect. Never shows a token.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/shell/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';
import type { RealtimeFeedInfo, SchwabStatusResponse } from '@/types';

const OUTCOMES: Record<string, { text: string; ok: boolean }> = {
  connected: { text: 'Connected to Schwab. Real-time flow starts with the next pass (within a minute or two during market hours).', ok: true },
  failed: { text: 'Schwab did not accept the sign-in. Check the app key, secret and callback URL, then try again.', ok: false },
  denied: { text: 'The Schwab sign-in was cancelled.', ok: false },
  state: { text: 'That sign-in link was stale or did not start here. Start again with Connect.', ok: false },
  unconfigured: { text: 'Schwab is not configured on the server yet (see the setup steps below).', ok: false },
  unlocked: { text: 'Set SITE_PASSWORD first: Schwab data is licensed to you alone, so the site must be locked.', ok: false },
};

const FEED_STATE: Record<RealtimeFeedInfo['state'], string> = {
  polling: 'Polling',
  idle: 'Idle — market closed',
  'signed-out': 'Not signed in',
  expired: 'Sign-in expired',
  unlocked: 'Off — site not locked',
};

/** "5d 3h", "4h 12m", "9m". */
export function formatSpan(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

async function getStatus(): Promise<SchwabStatusResponse> {
  const res = await fetch('/api/schwab/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as SchwabStatusResponse;
}

export function DataSourcesView(): JSX.Element {
  const status = useFlowStore((s) => s.status);
  const schwab = useQuery({ queryKey: ['schwab-status'], queryFn: getStatus, refetchInterval: 30_000 });
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    const o = new URLSearchParams(window.location.search).get('schwab');
    if (o) {
      setOutcome(o);
      // Drop the code from the address bar so a reload does not repeat the message.
      window.history.replaceState(null, '', '/connections');
    }
  }, []);

  const message = outcome ? OUTCOMES[outcome] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4 lg:p-6">
      <PageHeader
        title="Data sources"
        description={
          <>
            Every tracked name is covered by CBOE&rsquo;s free feed, 15 minutes delayed, which also supplies all the volatility and
            positioning analytics (IV, skew, open interest, dealer gamma) and everything the learning loop grades. Connecting your
            own Schwab account makes the put/call <em>flow</em> real time for the busiest names.
          </>
        }
        right={schwab.data?.siteLocked ? <LockButton /> : undefined}
      />

      {message && (
        <p
          role="status"
          className={cn(
            'rounded-md border px-3 py-2 text-xs',
            message.ok ? 'border-bullish/40 bg-bullish/10 text-bullish' : 'border-caution/40 bg-caution/10 text-caution',
          )}
        >
          {message.text}
        </p>
      )}

      <Card>
        <CardHeader title="Delayed feed · CBOE" right={<Pill tone="neutral">Always on</Pill>} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Tile label="Source" value={status?.provider === 'cboe' ? 'CBOE' : (status?.provider ?? '—')} sub="15 min delayed" />
          <Tile label="Names tracked" value={status ? status.tickersTracked.toLocaleString() : '—'} />
          <Tile
            label="Requests / min"
            value={status ? `${status.apiCallsLastMinute}` : '—'}
            sub={status ? `of ${status.rateLimitPerMinute} allowed` : undefined}
          />
          <Tile label="Market" value={status ? (status.marketOpen ? 'Open' : 'Closed') : '—'} />
        </div>
      </Card>

      {schwab.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : schwab.isError || !schwab.data ? (
        <Card>
          <p className="p-4 text-xs text-slate-400">Could not load the Schwab connection status.</p>
        </Card>
      ) : (
        <SchwabCard s={schwab.data} />
      )}
    </div>
  );
}

function SchwabCard({ s }: { s: SchwabStatusResponse }): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const feed = s.feed;

  const disconnect = async (): Promise<void> => {
    if (!window.confirm('Disconnect Schwab? Flow goes back to the 15-minute delayed feed.')) return;
    setBusy(true);
    await fetch('/api/schwab/disconnect', { method: 'POST' }).catch(() => null);
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: ['schwab-status'] });
  };

  const tone = s.state === 'connected' ? 'good' : s.state === 'expired' ? 'warn' : 'neutral';
  const label = { unconfigured: 'Not set up', disconnected: 'Not connected', connected: 'Connected', expired: 'Sign-in expired' }[s.state];
  const left = s.reconnectBy !== null ? s.reconnectBy - now : null;

  return (
    <Card>
      <CardHeader title="Real-time flow · Schwab" right={<Pill tone={tone}>{label}</Pill>} />
      <div className="space-y-4 p-4 text-xs">
        {s.state === 'unconfigured' ? (
          <SetupSteps />
        ) : !s.siteLocked ? (
          <p className="text-caution">
            Set <code>SITE_PASSWORD</code> on the server first. Schwab market data is licensed for your personal use, so real-time
            polling stays off while the site is open to anyone with the link.
          </p>
        ) : (
          <>
            {s.state === 'connected' && feed && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Tile label="Feed" value={FEED_STATE[feed.state]} sub={feed.delayed ? 'Schwab is sending DELAYED data' : undefined} />
                <Tile label="Real-time names" value={feed.liveTickers.toLocaleString()} sub={`rotating ${feed.hotSetSize} busiest`} />
                <Tile label="Requests / min" value={String(feed.callsLastMinute)} sub={`of ${feed.perMinute} allowed`} />
                <Tile
                  label="Reconnect within"
                  value={left !== null ? formatSpan(left) : '—'}
                  sub={s.reconnectBy !== null ? new Date(s.reconnectBy).toLocaleString() : undefined}
                />
              </div>
            )}
            {s.state === 'connected' && left !== null && left < 86_400_000 && (
              <p className="text-caution">Schwab ends every sign-in after 7 days. Reconnect before it runs out to stay real time.</p>
            )}
            {s.state === 'expired' && (
              <p className="text-caution">
                The weekly Schwab sign-in has run out, so flow is back on the 15-minute delayed feed. Reconnect to resume real time.
              </p>
            )}
            {s.state === 'disconnected' && (
              <p className="text-slate-400">
                Sign in with your Schwab login. Schwab asks you to pick the account(s) to share; any one works — only market data is
                read, never balances, positions or orders. Schwab ends each sign-in after 7 days, so you will reconnect weekly.
              </p>
            )}
            {feed?.delayed && (
              <p className="text-caution">
                Schwab marked this data as delayed. Real-time options quotes may need the market-data agreements accepted on
                schwab.com (non-professional use).
              </p>
            )}
            {!s.persisted && s.state === 'connected' && (
              <p className="text-slate-500">No database is connected, so a server restart or redeploy forgets this sign-in.</p>
            )}
            {(s.lastError || feed?.lastError) && (
              <p className="text-slate-500">
                Last error: <span className="text-slate-400">{s.lastError ?? feed?.lastError}</span>
              </p>
            )}
            {feed && feed.unsupported > 0 && (
              <p className="text-slate-500">
                {feed.unsupported} name{feed.unsupported === 1 ? '' : 's'} Schwab could not return whole today stay on the delayed
                feed.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/schwab/connect"
                className="inline-flex h-8 items-center rounded-md bg-blue-600 px-3 font-medium text-white hover:bg-blue-500"
              >
                {s.state === 'disconnected' ? 'Connect Schwab' : 'Reconnect'}
              </a>
              {s.state !== 'disconnected' && (
                <button
                  onClick={() => void disconnect()}
                  disabled={busy}
                  className="h-8 rounded-md border border-surface-border px-3 text-slate-300 hover:bg-surface-overlay disabled:opacity-50"
                >
                  Disconnect
                </button>
              )}
            </div>
            {s.callbackUrl && (
              <p className="text-[10px] text-slate-600">
                Callback URL registered with Schwab must be exactly <code className="text-slate-500">{s.callbackUrl}</code>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function SetupSteps(): JSX.Element {
  return (
    <ol className="list-decimal space-y-1.5 pl-4 text-slate-400">
      <li>
        At developer.schwab.com, create an app with the <strong>Market Data Production</strong> product and the callback URL{' '}
        <code>https://&lt;your-domain&gt;/api/schwab/callback</code>. Approval takes a few days.
      </li>
      <li>
        On the server (Railway → Variables), set <code>SCHWAB_APP_KEY</code>, <code>SCHWAB_APP_SECRET</code>,{' '}
        <code>SCHWAB_CALLBACK_URL</code> and <code>SITE_PASSWORD</code>.
      </li>
      <li>Redeploy, sign in to this site, and press Connect here.</li>
    </ol>
  );
}

function LockButton(): JSX.Element {
  return (
    <button
      onClick={() =>
        void fetch('/api/logout', { method: 'POST' }).then(() => {
          window.location.href = '/login';
        })
      }
      className="h-8 rounded-md border border-surface-border px-3 text-xs text-slate-300 hover:bg-surface-overlay"
    >
      Lock this browser
    </button>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-base font-semibold tnum text-slate-100">{value}</p>
      {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'neutral'; children: string }): JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
        tone === 'good' && 'border-bullish/40 text-bullish',
        tone === 'warn' && 'border-caution/40 text-caution',
        tone === 'neutral' && 'border-surface-border text-slate-400',
      )}
    >
      {children}
    </span>
  );
}
