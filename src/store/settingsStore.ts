'use client';

import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppSettings } from '@/types';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  saving: boolean;
  setLocal: (patch: Partial<AppSettings>) => void;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  saving: false,

  setLocal: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  load: async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) set({ settings: (await res.json()) as AppSettings, loaded: true });
    } catch {
      set({ loaded: true }); // fall back to defaults
    }
  },

  save: async (patch) => {
    const optimistic = { ...get().settings, ...patch };
    set({ settings: optimistic, saving: true });
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(optimistic),
      });
      if (res.ok) set({ settings: (await res.json()) as AppSettings });
    } catch {
      // keep optimistic value; next load reconciles
    } finally {
      set({ saving: false });
    }
  },
}));
