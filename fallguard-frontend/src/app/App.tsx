import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { AuthProvider } from '../features/auth/AuthContext';
import { useUiStore } from '../store/uiStore';

/** Light / dark / system theme on <html>, for every page (sign-in pages included). */
function useTheme() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

export function App() {
  useTheme();
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
