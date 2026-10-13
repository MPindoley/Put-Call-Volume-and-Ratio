'use client';

/**
 * useState that remembers its value in localStorage — for per-browser layout
 * preferences (side panel open, active tab, hidden columns). Starts from the
 * default on the server and on first client render (no hydration mismatch),
 * then adopts the stored value. Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and the default simply sticks.
 */
import { useCallback, useEffect, useState } from 'react';

export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid: (v: unknown) => v is T = (v): v is T => typeof v === typeof initial,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (isValid(parsed)) setValue(parsed);
    } catch {
      /* storage unavailable or corrupt — keep the default */
    }
    // Read once per key; `isValid` is a pure guard and deliberately not a dependency.
  }, [key]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* ignore — the preference just won't survive a reload */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, update];
}
