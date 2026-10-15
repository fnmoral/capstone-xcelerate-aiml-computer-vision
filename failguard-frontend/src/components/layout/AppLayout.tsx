import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useUiStore } from '../../store/uiStore';
import { Header } from './Header';
import { Navigation } from './Navigation';
import { MainContainer } from './MainContainer';
import { Footer } from './Footer';
import './AppLayout.css';

/** App shell: Header + Navigation + MainContainer(page, Footer). */
export function AppLayout() {
  const { navCollapsed, theme, closeNav } = useUiStore();
  const { pathname } = useLocation();

  useEffect(() => closeNav(), [pathname, closeNav]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeNav();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeNav]);

  return (
    <div className={`layout${navCollapsed ? ' layout--collapsed' : ''}`}>
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
