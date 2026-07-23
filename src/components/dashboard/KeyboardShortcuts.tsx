'use client';

/**
 * Global keyboard shortcuts (UI-CONSTRAINTS §Keyboard). Mounted once in Dashboard.
 *   /   focus the ticker search
 *   Esc clear + blur the search
 *   ?   toggle this help overlay
 * Shortcuts are ignored while typing in an input/textarea (except Esc).
 */
import { useEffect, useState } from 'react';
import { useFlowStore } from '@/store/flowStore';

const SHORTCUTS: [string, string][] = [
  ['/', 'Focus ticker search'],
  ['Esc', 'Clear + blur search'],
  ['?', 'Toggle this help'],
];

export function KeyboardShortcuts(): JSX.Element | null {
  const [helpOpen, setHelpOpen] = useState(false);
  const setSearch = useFlowStore((s) => s.setSearch);

  useEffect(() => {
    const searchEl = (): HTMLInputElement | null => document.getElementById('ticker-search') as HTMLInputElement | null;
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;

      if (e.key === 'Escape') {
        if (typing && el?.id === 'ticker-search') {
          setSearch('');
          (el as HTMLInputElement).blur();
          e.preventDefault();
        }
        setHelpOpen(false);
        return;
      }
      if (typing) return; // don't hijack keys while the user is typing

      if (e.key === '/') {
        searchEl()?.focus();
        e.preventDefault();
      } else if (e.key === '?') {
        setHelpOpen((v) => !v);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearch]);

  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="w-72 rounded-lg border border-surface-border bg-surface-raised p-4 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Keyboard shortcuts</p>
        <ul className="space-y-1">
          {SHORTCUTS.map(([key, label]) => (
            <li key={key} className="flex items-center justify-between">
              <span className="text-slate-300">{label}</span>
              <kbd className="rounded border border-surface-border bg-surface px-1.5 py-0.5 tnum text-slate-400">{key}</kbd>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[10px] text-slate-600">Esc or click to close.</p>
      </div>
    </div>
  );
}
