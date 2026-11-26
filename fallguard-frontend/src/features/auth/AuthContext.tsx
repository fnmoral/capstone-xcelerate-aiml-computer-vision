import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { accounts, type Me } from '../../services/api/accounts';
import { UNAUTHORIZED_EVENT } from '../../services/api/client';
import { BrandLoader } from '../../components/ui/Brand';
import { closeAllLiveStreams } from '../live-view/live/liveStreams';

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: string | null;
  /** Re-reads the signed-in user (after sign-in, role or organization changes). */
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  /** Whether the user's role allows a permission (see the Members page). */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await accounts.me();
      setMe(m);
      setError(null);
      return m;
    } catch (e) {
      const status = (e as { status?: number }).status;
      setMe(null);
      // 401 just means "not signed in"; anything else is worth showing.
      setError(status === 401 ? null : e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);
  // Role changes made by an admin show up within a minute.
  useEffect(() => {
    if (!me) return;
    const t = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
    return () => window.clearInterval(t);
  }, [me, refresh]);

  const signOut = useCallback(async () => {
    try { await accounts.logout(); } finally { closeAllLiveStreams(); setMe(null); }
  }, []);

  const value = useMemo<AuthState>(() => ({
    me, loading, error, refresh, signOut,
    can: (p) => !!me?.permissions.includes(p),
  }), [me, loading, error, refresh, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Permission keys (backend internal/auth/perms.go). */
export const PERM = {
  viewLive: 'live.view',
  viewEvents: 'events.view',
  viewAnalytics: 'analytics.view',
  viewReports: 'reports.view',
  viewLogs: 'logs.view',
  manageAlerts: 'alerts.manage',
  incidentReports: 'incident_reports.manage',
  manageCameras: 'cameras.manage',
  manageDetection: 'detection.manage',
  manageNotifications: 'notifications.manage',
  manageSettings: 'settings.manage',
  viewEmails: 'emails.view',
  viewMembers: 'members.view',
  manageMembers: 'members.manage',
  manageRoles: 'roles.manage',
} as const;

/** Renders the app only for signed-in users; others go to the sign-in page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, error, refresh } = useAuth();
  const location = useLocation();
  if (loading) return <BrandLoader />;
  if (error && !me) {
    return (
      <div className="auth-page"><div className="auth-card card">
        <h1 className="auth-title">Can't reach FallGuard</h1>
        <p className="notice notice--error">{error}</p>
        <button className="btn btn--primary" onClick={() => void refresh()}>Try again</button>
      </div></div>
    );
  }
  if (!me) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  return <>{children}</>;
}

/** Shows a page only to roles with the permission. */
export function RequirePermission({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const perms = Array.isArray(perm) ? perm : [perm];
  if (!perms.some(can)) {
    return (
      <div className="empty" role="alert">
        <h1 className="empty__title">You don't have access to this page</h1>
        <p className="empty__body">Your role in this organization doesn't include it. Ask an admin if you need access.</p>
      </div>
    );
  }
  return <>{children}</>;
}
