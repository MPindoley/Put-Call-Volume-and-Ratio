'use client';

/** Site lock sign-in (session.ts). Shown only when SITE_PASSWORD is set. */
import { useState, type FormEvent } from 'react';

export default function LoginPage(): JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(res ? 'Wrong password.' : 'Could not reach the server.');
      return;
    }
    const next = new URLSearchParams(window.location.search).get('next');
    // Only same-site paths: never bounce to another origin from a query parameter.
    window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-xs rounded-lg border border-surface-border bg-surface-raised p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-blue-500/15 text-blue-400" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 17l5-6 4 4 8-10" />
            </svg>
          </span>
          <h1 className="text-sm font-semibold text-slate-100">Options Flow</h1>
        </div>
        <label className="block text-xs text-slate-400" htmlFor="site-password">
          Password
        </label>
        <input
          id="site-password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-surface-border bg-surface px-3 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
        />
        {error && <p className="mt-2 text-xs text-bearish">{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mt-4 h-9 w-full rounded-md bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
