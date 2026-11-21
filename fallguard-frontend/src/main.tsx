import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { reloadForUpdate } from './components/ui/RouteError';
import { router } from './app/router';
import './styles/tokens.css';
import './styles/global.css';

// A preloaded file of the old version is gone (the app was updated while open): reload once.
// Go straight to the page the user was opening (the router knows the pending navigation).
window.addEventListener('vite:preloadError', (e) => {
  const next = router.state.navigation.location;
  if (reloadForUpdate(next ? next.pathname + next.search : undefined)) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
