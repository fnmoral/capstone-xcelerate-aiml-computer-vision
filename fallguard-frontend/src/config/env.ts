/** Runtime configuration. Values come from Vite env vars (see .env.example). */
export const env = {
  // Same origin by default: nginx (Docker) or the Vite dev proxy forwards /api to the backend.
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  // Push channel for later (services/realtime); the pages poll the REST API for now.
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000/ws',
  appVersion: import.meta.env.VITE_APP_VERSION ?? '0.2.0',
};
