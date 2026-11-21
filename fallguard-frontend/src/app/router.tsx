import { createBrowserRouter, createHashRouter, Navigate } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { homePath, NAV_ITEMS } from '../config/navigation';
import { NotFoundPage } from '../features/not-found/NotFoundPage';
import { RouteError } from '../components/ui/RouteError';
import '../features/auth/auth.css';
import { RequireAuth, RequirePermission, useAuth } from '../features/auth/AuthContext';
import {
  DemoPage, ForgotPasswordPage, InvitePage, LoginPage, ResetPasswordPage, SignupPage, VerifyEmailPage,
} from '../features/auth/AuthPages';

/**
 * Route table is generated from NAV_ITEMS so navigation and routing
 * can never drift apart. Each page is lazy loaded (code splitting).
 * Sign-in pages are public; everything under AppLayout needs a session, and each page
 * also checks the role's permission.
 */
// Hash routing for static hosts that cannot rewrite deep links (set VITE_ROUTER=hash).
const createRouter = import.meta.env.VITE_ROUTER === 'hash' ? createHashRouter : createBrowserRouter;

function Home() {
  const { can } = useAuth();
  return <Navigate to={homePath(can)} replace />;
}

const page = (load: () => Promise<{ default: React.ComponentType }>, perm: string[] = []) => ({
  lazy: async () => {
    const Page = (await load()).default;
    return { Component: () => (perm.length ? <RequirePermission perm={perm}><Page /></RequirePermission> : <Page />) };
  },
});

export const router = createRouter([{
  // Any page that fails (or a page file missing after an update) gets a friendly screen.
  errorElement: <RouteError />,
  children: [
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/invite/:token', element: <InvitePage /> },
  // Demo access link: view-only visitor, no account (Members & Roles → Demo access links).
  { path: '/demo/:token', element: <DemoPage /> },
  // Public, view-only incident video from a share link (no account needed).
  { path: '/shared/:token', ...page(() => import('../features/shared/SharedIncidentPage')) },
  {
    path: '/',
    element: <RequireAuth><AppLayout /></RequireAuth>,
    children: [{
      // Errors inside the app keep the header and menu around them.
      errorElement: <RouteError inApp />,
      children: [
      { index: true, element: <Home /> },
      ...NAV_ITEMS.map((item) => ({ path: item.path.slice(1), ...page(item.load, item.perm) })),
      // Detail pages (not in the navigation)
      { path: 'events/:id', ...page(() => import('../features/events/IncidentPage'), ['events.view', 'reports.view']) },
      {
        path: 'incident-reports/:id',
        ...page(() => import('../features/incident-reports/ReportEditorPage'), ['reports.view', 'incident_reports.manage']),
      },
      { path: 'account', ...page(() => import('../features/account/AccountPage')) },
      { path: '*', element: <NotFoundPage /> },
      ],
    }],
  },
  ],
}]);
