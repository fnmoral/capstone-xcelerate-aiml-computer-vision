import { createBrowserRouter, createHashRouter, Navigate } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { NAV_ITEMS } from '../config/navigation';
import { NotFoundPage } from '../features/not-found/NotFoundPage';

/**
 * Route table is generated from NAV_ITEMS so navigation and routing
 * can never drift apart. Each page is lazy loaded (code splitting).
 */
// Hash routing for static hosts that cannot rewrite deep links (set VITE_ROUTER=hash).
const createRouter = import.meta.env.VITE_ROUTER === 'hash' ? createHashRouter : createBrowserRouter;

export const router = createRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/live" replace /> },
      ...NAV_ITEMS.map((item) => ({
        path: item.path.slice(1),
        lazy: async () => ({ Component: (await item.load()).default }),
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
