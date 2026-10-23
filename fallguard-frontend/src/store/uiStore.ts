import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

interface UiState {
  navOpen: boolean; // mobile drawer
  navCollapsed: boolean; // desktop rail
  theme: Theme;
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  toggleCollapsed: () => void;
  setTheme: (t: Theme) => void;
}

/** Client-only UI state. Server data does NOT live here (see docs/ARCHITECTURE.md). */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      navOpen: false,
      navCollapsed: false,
      theme: 'system',
      openNav: () => set({ navOpen: true }),
      closeNav: () => set({ navOpen: false }),
      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      toggleCollapsed: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'fallguard-ui',
      partialize: (s) => ({ navCollapsed: s.navCollapsed, theme: s.theme }),
    },
  ),
);
