import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

/** The theme in use: this browser's choice, else the organization's default (remembered from
 *  the last sign-in, so sign-in pages match), else light. */
export function effectiveTheme(s: { theme: Theme | null; orgTheme: Theme | null }): Theme {
  return s.theme ?? s.orgTheme ?? 'light';
}

/** Live View layouts: 'auto' = every camera, scrolling; '1' / '2' / '4' / '8' = that many
 *  per page, fitted to the window; 'fit' = all cameras fitted to the window. */
export type LiveLayout = 'auto' | '1' | '2' | '4' | '8' | 'fit';

/** What Live View draws over the video. */
export interface LiveOverlay {
  boxes: boolean; // box around each person
  label: boolean; // Upright / Falling / Lying / Unclear
  track: boolean; // person number (#3)
  confidence: boolean; // detection confidence (91%)
  center: boolean; // centre of the box
  skeleton: boolean; // lines between body points
  keypoints: boolean; // the 17 body points
  grid: boolean; // grid lines over the picture
}

export const DEFAULT_OVERLAY: LiveOverlay = {
  boxes: true, label: true, track: true, confidence: true,
  center: false, skeleton: false, keypoints: false, grid: false,
};

/** Incident videos: the box, status and person number of the incident's person. */
export const DEFAULT_INCIDENT_OVERLAY: LiveOverlay = {
  boxes: true, label: true, track: true, confidence: false,
  center: false, skeleton: false, keypoints: false, grid: false,
};

interface UiState {
  navOpen: boolean; // mobile drawer
  navCollapsed: boolean; // desktop rail
  navPinned: boolean; // tablet-width windows: keep the menu open beside the page instead of a pop-out
  theme: Theme | null; // this browser's choice; null = follow the organization's default
  orgTheme: Theme | null; // the organization's default theme (Settings), remembered here
  orgIncidentOverlay: LiveOverlay; // the organization's default overlays on incident videos
  liveLayout: LiveLayout; // Live View's default layout
  overlayDefault: LiveOverlay; // Live View's overlays when the app opens (saved in this browser)
  liveOverlay: LiveOverlay; // the overlays shown now (not saved)
  noteAuthor: string; // name put on notes (no user accounts yet)
  notifClearedAt: string | null; // bell: hide notifications from before this time (alerts stay open)
  timeZone: string | null; // facility time zone from the API (Settings); null = this browser's
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  toggleCollapsed: () => void;
  togglePinned: () => void;
  setTheme: (t: Theme | null) => void;
  setOrgTheme: (t: Theme | null) => void;
  setOrgIncidentOverlay: (o: Partial<LiveOverlay> | null) => void;
  setLiveLayout: (l: LiveLayout) => void;
  setLiveOverlay: (o: LiveOverlay) => void;
  setOverlayDefault: (o: LiveOverlay) => void;
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
      navPinned: false,
      theme: null,
      orgTheme: null,
      orgIncidentOverlay: DEFAULT_INCIDENT_OVERLAY, // from the API (AppLayout), not saved here
      liveLayout: 'auto',
      overlayDefault: DEFAULT_OVERLAY,
      liveOverlay: DEFAULT_OVERLAY,
      noteAuthor: '',
      notifClearedAt: null,
      timeZone: null,
      openNav: () => set({ navOpen: true }),
      closeNav: () => set({ navOpen: false }),
      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      toggleCollapsed: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      togglePinned: () => set((s) => ({ navPinned: !s.navPinned, navOpen: false })),
      setTheme: (theme) => set({ theme }),
      setOrgTheme: (orgTheme) => set({ orgTheme }),
      setOrgIncidentOverlay: (o) => set({ orgIncidentOverlay: { ...DEFAULT_INCIDENT_OVERLAY, ...o } }),
      setLiveLayout: (liveLayout) => set({ liveLayout }),
      setLiveOverlay: (liveOverlay) => set({ liveOverlay }),
      setOverlayDefault: (overlayDefault) => set({ overlayDefault }),
      setNoteAuthor: (noteAuthor) => set({ noteAuthor }),
      clearNotifications: () => set({ notifClearedAt: new Date().toISOString() }),
      setTimeZone: (timeZone) => set({ timeZone }),
    }),
    {
      name: 'fallguard-ui',
      partialize: (s) => ({ navCollapsed: s.navCollapsed, navPinned: s.navPinned, theme: s.theme, orgTheme: s.orgTheme,
        liveLayout: s.liveLayout,
        overlayDefault: s.overlayDefault, noteAuthor: s.noteAuthor,
        notifClearedAt: s.notifClearedAt, timeZone: s.timeZone }),
      // The overlays shown start from the saved default each time the app opens; options
      // added in a newer version get their built-in default.
      merge: (persisted, current) => {
        const saved = persisted as Partial<UiState> | undefined;
        const overlay = { ...DEFAULT_OVERLAY, ...saved?.overlayDefault };
        // Older versions saved 'system' as the built-in default: treat it as "no choice yet".
        const theme = saved?.theme === 'system' ? null : saved?.theme ?? null;
        return { ...current, ...saved, theme, overlayDefault: overlay, liveOverlay: overlay };
      },
    },
  ),
);
