# FallGuard Vision: Frontend (Module 1)

React + TypeScript + Vite web interface for FallGuard Vision. It talks only to the core
backend API (`backend-module/api`) under `/api`.

| Page | What it does |
|---|---|
| Live View | Annotated live video per camera (boxes + upright / falling / lying), who is in view, active-incident banner. Layouts: Auto (scroll), 1 / 2 / 4 / 8 per page or Fit all (fitted to the window); click a camera to enlarge it; "Set as default" (also in Settings). Up to 4 tiles stream live; more refresh once a second (browsers allow ~6 connections per site). A camera that stopped working (with its alert on) gets a red dashed outline and a banner |
| Fall Events | All incidents with status filters; detail page with the **video** of the fall (one camera full size; several: all at once or one at a time; photo while it is still recording), label timeline, alert actions (acknowledge, resolve, false alarm), notes from several people (name remembered in the browser), and a history of who did what and when. The list shows each incident's latest note |
| Analytics | Active incidents, open alerts, falls per day, average time down, by camera / outcome / severity |
| Reports & Export | Time window (24 h / 7 / 30 days / all / custom from–to) + status, severity, where (zone or camera), alert status; preview; CSV download of the incident report and of the activity log |
| Cameras | Add IP cameras (through the gateway): **5 stream at once, up to 50 saved**; the rest wait paused (standby) and **Switch to this** swaps one in for a streaming camera, no remove / re-add, set location and zone, pause / resume, remove, "alert me if it stops working" toggle (default on). **Camera order**: drag the names (or use the arrows) to set the order in Live View and fall-event videos; saved for everyone |
| Camera Logs | Each camera's status right now (online, paused, not working, not connected) and since when; full history of changes with who made them; CSV export (for audits) |
| Detection Settings | Device in use (GPU / CPU) and the actual analysis rate per camera; **minimum person confidence** (tunable: raise it if objects cause false alarms); the detector's thresholds and timings and the clip settings (read-only, from ml-service) |
| Settings | Health of every service, the gateway's stream-hub address, theme |

The header bell lists open fall alerts and cameras that stopped working. **Clear** hides them in that browser only; the alerts stay open in Fall Events until someone acknowledges or resolves them.

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
