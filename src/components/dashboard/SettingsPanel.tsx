'use client';

/**
 * Slide-over settings: spike sensitivity, premium/contract thresholds, update
 * cadence, sound, watchlist. Persists via PUT /api/settings (DB-backed when
 * available) and applies to the running detector immediately.
 */
import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { formatPremium } from '@/lib/utils';

export function SettingsPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const { settings, load, save, saving } = useSettingsStore();
  const [watchlistDraft, setWatchlistDraft] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setWatchlistDraft(settings.watchlist.join(', '));
  }, [settings.watchlist]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded p-1.5 text-slate-400 hover:bg-surface-overlay hover:text-slate-200"
        aria-label="Open settings"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setOpen(false)}>
          <div
            className="h-full w-96 overflow-auto border-l border-surface-border bg-surface-raised p-4"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Settings"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-200" aria-label="Close settings">
                ✕
              </button>
            </div>

            <div className="space-y-5 text-xs">
              <label className="block">
                <span className="mb-1 flex justify-between text-slate-300">
                  <span>Spike sensitivity</span>
                  <span className="tnum text-slate-500">
                    {settings.sensitivity.toFixed(1)}× {settings.sensitivity < 1 ? '(aggressive)' : settings.sensitivity > 1 ? '(conservative)' : ''}
                  </span>
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={settings.sensitivity}
                  onChange={(e) => void save({ sensitivity: Number(e.target.value) })}
                  className="w-full accent-blue-500"
                />
                <span className="mt-0.5 flex justify-between text-[10px] text-slate-600">
                  <span>Aggressive 0.5×</span>
                  <span>Conservative 3.0×</span>
                </span>
              </label>

              <label className="block">
                <span className="mb-1 flex justify-between text-slate-300">
                  <span>Minimum premium for alerts</span>
                  <span className="tnum text-slate-500">{formatPremium(settings.minPremium)}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1_000_000}
                  step={50_000}
                  value={settings.minPremium}
                  onChange={(e) => void save({ minPremium: Number(e.target.value) })}
                  className="w-full accent-blue-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 flex justify-between text-slate-300">
                  <span>Minimum contracts</span>
                  <span className="tnum text-slate-500">{settings.minContracts}</span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={1000}
                  step={10}
                  value={settings.minContracts}
                  onChange={(e) => void save({ minContracts: Number(e.target.value) })}
                  className="w-full accent-blue-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-slate-300">Update frequency</span>
                <select
                  value={settings.updateFrequencySec}
                  onChange={(e) => void save({ updateFrequencySec: Number(e.target.value) })}
                  className="w-full rounded border border-surface-border bg-surface px-2 py-1.5 text-slate-200"
                >
                  <option value={15}>15 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={300}>5 minutes</option>
                </select>
                <span className="mt-0.5 block text-[10px] text-slate-600">
                  Effective cadence is limited by your Polygon plan; requires restart to change the poll loop.
                </span>
              </label>

              <label className="flex items-center justify-between">
                <span className="text-slate-300">Alert sound</span>
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={(e) => void save({ soundEnabled: e.target.checked })}
                  className="h-4 w-4 accent-blue-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-slate-300">Watchlist (priority polling + pinned)</span>
                <input
                  value={watchlistDraft}
                  onChange={(e) => setWatchlistDraft(e.target.value)}
                  onBlur={() =>
                    void save({
                      watchlist: watchlistDraft
                        .split(',')
                        .map((s) => s.trim().toUpperCase())
                        .filter(Boolean),
                    })
                  }
                  placeholder="SPY, QQQ, AAPL…"
                  className="w-full rounded border border-surface-border bg-surface px-2 py-1.5 text-slate-200 placeholder:text-slate-600"
                />
              </label>

              <p className="text-[10px] text-slate-600">
                {saving ? 'Saving…' : 'Settings apply immediately and persist to the database when connected.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
