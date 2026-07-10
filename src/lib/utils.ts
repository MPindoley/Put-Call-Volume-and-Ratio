import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function formatPremium(n: number): string {
  return n === 0 ? '$0' : `$${formatCompact(n)}`;
}

export function formatRatio(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

export function formatTime(epochMs: number, timezone = 'America/New_York'): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(epochMs));
}

/** Minutes since NYSE open (9:30 ET); negative before open, may exceed 390 after close. */
export function minutesSinceOpen(now = new Date()): number {
  const et = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZone: 'America/New_York',
  }).formatToParts(now);
  const hour = Number(et.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(et.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute - (9 * 60 + 30);
}

export function isMarketHours(now = new Date()): boolean {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'America/New_York',
  }).format(now);
  if (day === 'Sat' || day === 'Sun') return false;
  const m = minutesSinceOpen(now);
  return m >= 0 && m <= 390;
}

/** 30-minute trading-day bucket index, clamped to 0–12. */
export function tradingBucket(now = new Date()): number {
  const m = minutesSinceOpen(now);
  return Math.min(12, Math.max(0, Math.floor(m / 30)));
}
