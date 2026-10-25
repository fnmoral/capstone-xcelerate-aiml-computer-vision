/** Runtime configuration. Values come from Vite env vars (see .env.example). */
export const env = {
  // Same origin by default: nginx (Docker) or the Vite dev proxy forwards /api to the backend.
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api",
  // Same origin by default: nginx (Docker) or the Vite dev proxy forwards /stream-hub to the backend.
  streamBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "/stream-hub",
  // Push channel for later (services/realtime); the pages poll the REST API for now.
  wsUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws",
  // MAJOR.MINOR.PATCH, worked out from package.json and git at build time (vite.config.ts).
  appVersion: import.meta.env.VITE_APP_VERSION ?? "1.0.0",
};
