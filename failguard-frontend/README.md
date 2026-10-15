# FailGuard Vision: Frontend (Module 1)

React + TypeScript + Vite web interface for FailGuard Vision.

## Run
```
npm install
cp .env.example .env
npm run dev        # http://localhost:5173
npm run build      # type check + production build
npm run lint
```

## Jira
- CAP-27 Frontend architecture: see `docs/ARCHITECTURE.md`
- CAP-29 Basic components: `src/components/layout/` (Header, Navigation, MainContainer, Footer, AppLayout)

Pages currently show empty states. Backend, streaming and auth are not connected yet.
