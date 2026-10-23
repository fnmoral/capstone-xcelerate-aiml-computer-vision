# FallGuard Vision: Frontend (Module 1)

React + TypeScript + Vite web interface for FallGuard Vision. It talks only to the core
backend API (`backend-module/api`) under `/api`.

| Page | What it does |
|---|---|
| Live View | Annotated live video per camera (boxes + upright / falling / lying), who is in view, active-incident banner |
| Fall Events | All incidents with status filters; detail page with photos, label timeline, alert actions (acknowledge, resolve, false alarm) and notes |
| Analytics | Active incidents, open alerts, falls per day, average time down, by camera / outcome / severity |
| Cameras | Add IP cameras (through the gateway), set location and zone, pause / resume, remove |
| Detection Settings | The detector's thresholds and timings (read-only, from ml-service) |
| Settings | Health of every service, the gateway's stream-hub address, theme |

Live data is polled (every 2–10 s); there is no push channel yet. User accounts are not
implemented: the API serves one tenant (`TENANT`, default `demo-facility`).

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
