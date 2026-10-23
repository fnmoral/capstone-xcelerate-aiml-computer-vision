import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

/** Live View layouts: 'auto' = every camera, scrolling; '1' / '2' / '4' / '8' = that many
 *  per page, fitted to the window; 'fit' = all cameras fitted to the window. */
export type LiveLayout = 'auto' | '1' | '2' | '4' | '8' | 'fit';

interface UiState {
  navOpen: boolean; // mobile drawer
  navCollapsed: boolean; // desktop rail
  theme: Theme;
  liveLayout: LiveLayout; // Live View's default layout
  noteAuthor: string; // name put on notes (no user accounts yet)
  notifClearedAt: string | null; // bell: hide notifications from before this time (alerts stay open)
  timeZone: string | null; // facility time zone from the API (Settings); null = this browser's
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  toggleCollapsed: () => void;
  setTheme: (t: Theme) => void;
  setLiveLayout: (l: LiveLayout) => void;
  setNoteAuthor: (name: string) => void;
  clearNotifications: () => void;
  setTimeZone: (tz: string | null) => void;
}

/** Client-only UI state. Server data does NOT live here (see docs/ARCHITECTURE.md). */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      navOpen: false,
      navCollapsed: false,
      theme: 'system',
      liveLayout: 'auto',
      noteAuthor: '',
      notifClearedAt: null,
      timeZone: null,
      openNav: () => set({ navOpen: true }),
      closeNav: () => set({ navOpen: false }),
      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      toggleCollapsed: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      setTheme: (theme) => set({ theme }),
      setLiveLayout: (liveLayout) => set({ liveLayout }),
      setNoteAuthor: (noteAuthor) => set({ noteAuthor }),
      clearNotifications: () => set({ notifClearedAt: new Date().toISOString() }),
      setTimeZone: (timeZone) => set({ timeZone }),
    }),
    {
      name: 'fallguard-ui',
      partialize: (s) => ({ navCollapsed: s.navCollapsed, theme: s.theme, liveLayout: s.liveLayout, noteAuthor: s.noteAuthor,
        notifClearedAt: s.notifClearedAt, timeZone: s.timeZone }),
    },
  ),
);
