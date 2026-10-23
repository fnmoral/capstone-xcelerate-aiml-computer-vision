# FallGuard Vision: Frontend (Module 1)

React + TypeScript + Vite web interface for FallGuard Vision. It talks only to the core
backend API (`backend-module/api`) under `/api`.

| Page | What it does |
|---|---|
| Live View | Annotated live video per camera (boxes + upright / falling / lying), who is in view, active-incident banner. A camera that stopped working (with its alert on) gets a red dashed outline and a banner |
| Fall Events | All incidents with status filters; detail page with photos, label timeline, alert actions (acknowledge, resolve, false alarm), notes, and a history of who did what and when |
| Analytics | Active incidents, open alerts, falls per day, average time down, by camera / outcome / severity |
| Reports & Export | Time window (24 h / 7 / 30 days / all / custom from–to) + status, severity, where (zone or camera), alert status; preview; CSV download of the incident report and of the activity log |
| Cameras | Add IP cameras (through the gateway), set location and zone, pause / resume, remove, "alert me if it stops working" toggle (default on) |
| Camera Logs | Each camera's status right now (online, paused, not working, not connected) and since when; full history of changes with who made them; CSV export (for audits) |
| Detection Settings | The detector's thresholds and timings (read-only, from ml-service) |
| Settings | Health of every service, the gateway's stream-hub address, theme |

The header bell lists open fall alerts and cameras that stopped working.

Live data is polled (every 2–10 s); there is no push channel yet. User accounts are not
implemented: the API serves one tenant (`TENANT`, default `demo-facility`), and every action
is recorded as "Current user".

## Run

With Docker (whole platform, see `../DOCKER.md`): http://localhost:3000

For frontend development against the running stack:

```
npm install
npm run dev        # http://localhost:5173; /api is proxied to the backend on localhost:8100
npm run build      # type check + production build
npm run lint
```

Set `VITE_API_PROXY` to point the dev proxy elsewhere, or `VITE_API_BASE_URL` to call an
API on another origin directly.

## Jira
- CAP-27 Frontend architecture: see `docs/ARCHITECTURE.md`
- CAP-29 Basic components: `src/components/layout/` (Header, Navigation, MainContainer, Footer, AppLayout)
