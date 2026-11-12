import { create } from 'zustand';
import type { AppSettings, Job } from '@clipwright/project-schema';
import { api, ApiError, type BootData } from './api.js';

export interface ToastEntry { id: string; message: string; tone?: 'default' | 'error' }

interface AppState {
  boot: BootData | null;
  bootError: string | null;
  toasts: ToastEntry[];
  activeJobs: Job[];
  init: () => Promise<void>;
  refreshBoot: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  toast: (message: string, tone?: 'default' | 'error') => void;
  dismissToast: (id: string) => void;
  refreshJobs: () => Promise<void>;
  setActiveJobs: (jobs: Job[]) => void;
}

let toastId = 0;

export const useAppStore = create<AppState>()((set, get) => ({
  boot: null,
  bootError: null,
  toasts: [],
  activeJobs: [],

  init: async () => {
    try {
      const boot = await api.getBoot();
      set({ boot, bootError: null });
    } catch (err) {
      set({ bootError: err instanceof ApiError ? err.message : 'The app could not start. Try reopening it.' });
    }
  },

  refreshBoot: async () => {
    try { set({ boot: await api.getBoot() }); } catch { /* keep current boot */ }
  },

  updateSettings: async (patch) => {
    const settings = await api.updateSettings(patch);
    const boot = get().boot;
    if (boot) set({ boot: { ...boot, settings } });
  },

  toast: (message, tone) => {
    const id = `t${++toastId}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    if (tone !== 'error') {
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  refreshJobs: async () => {
    try {
      const { active } = await api.jobs.list();
      set({ activeJobs: active });
    } catch { /* jobs are advisory in the UI */ }
  },

  setActiveJobs: (jobs) => set({ activeJobs: jobs }),
}));
