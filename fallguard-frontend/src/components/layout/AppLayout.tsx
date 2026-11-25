import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { Header } from './Header';
import { Navigation } from './Navigation';
import { MainContainer } from './MainContainer';
import { Footer } from './Footer';
import './AppLayout.css';

/** App shell: Header + Navigation + MainContainer(page, Footer). */
export function AppLayout() {
  const { navCollapsed, navPinned, closeNav, setTimeZone, setOrgTheme, setOrgIncidentOverlay } = useUiStore();
  // Facility settings (time zone): picked up by every page, re-checked every minute.
  const { data: settings } = usePolling(() => api.settings(), 60000);
  useEffect(() => {
    if (!settings) return;
    setTimeZone(settings.timezone);
    setOrgTheme(settings.theme ?? null);
    setOrgIncidentOverlay(settings.incident_overlay ?? null);
  }, [settings, setTimeZone, setOrgTheme, setOrgIncidentOverlay]);
  const { pathname } = useLocation();

  useEffect(() => closeNav(), [pathname, closeNav]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeNav();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeNav]);

  return (
    <div className={`layout${navCollapsed ? ' layout--collapsed' : ''}${navPinned ? ' layout--pinned' : ''}`}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <div className="layout__body">
        <Navigation />
        <MainContainer>
          <Suspense fallback={<p className="layout__loading">Loading…</p>}>
            <Outlet />
          </Suspense>
        </MainContainer>
      </div>
      <Footer />
    </div>
  );
}
