/** Runtime configuration. Values come from Vite env vars (see .env.example). */
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api',
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000/ws',
  appVersion: import.meta.env.VITE_APP_VERSION ?? '0.1.0',
};
