# FailGuard Vision: Module 1 Frontend Architecture

Jira: CAP-27 (architecture) and CAP-29 (basic components). Parent: CAP-21 Module 1 - Front-end.
Status: Draft for team review. Owner: Berkin Öztürk. Last updated: 2026-10-12.

## 1. Scope

Module 1 is the web interface of FailGuard Vision. Per the Project Vision Document it lets users watch camera streams, manage cameras, review detected fall events, view analytics, configure detection behaviour, and manage settings. It talks only to the Core Backend (Module 2) over REST and WebSocket. It never connects to cameras, the message broker, or GPU workers directly.

| Item | Status |
|---|---|
| App shell (header, navigation, main container, footer) | IMPLEMENTED (CAP-29) |
| Routing for all six sections, lazy loaded | IMPLEMENTED |
| Responsive layout (mobile drawer, desktop sidebar, collapsible rail) | IMPLEMENTED |
| Light / dark / system theme | IMPLEMENTED |
| REST client and WebSocket client | IMPLEMENTED as stubs, not connected to a backend |
| Live video playback | OPEN DESIGN DECISION (depends on Module 3 output format) |
| Camera CRUD, events, analytics, detection settings | PLANNED (pages exist as empty states) |
| Authentication / multi-tenant UI | PLANNED |

## 2. Technology

| Concern | Choice | Reason |
|---|---|---|
| Language / UI | TypeScript + React 19 | Confirmed in the Project Vision Document |
| Build tool | Vite 8 | Fast dev server, standard for React + TS |
| Routing | React Router 7 (data router) | Nested layouts, lazy routes, widely known |
| Client UI state | Zustand 5 | Small, no boilerplate, easy for new contributors |
| Server state | Plain `apiRequest` for now; TanStack Query proposed | [TEAM CONFIRMATION REQUIRED] before adding |
| Styling | Plain CSS with design tokens (CSS variables), one CSS file per component | No extra dependency; theming via variables |
| Lint | oxlint (template default) | Already configured |

## 3. Folder structure

```
src/
  main.tsx                 entry: mounts App, loads global styles
  app/
    App.tsx                RouterProvider
    router.tsx             route table, built from config/navigation.ts
  config/
    navigation.ts          SINGLE source of truth for pages (path, label, icon, section, lazy import)
    env.ts                 VITE_* environment variables
  components/
    layout/                app shell: AppLayout, Header, Navigation, MainContainer, Footer
    ui/                    reusable primitives: Icon, PageHeader, EmptyState, ui.css
  features/                one folder per product area; each owns its page + local components
    live-view/  events/  analytics/  cameras/  detection/  settings/  not-found/
  services/
    api/client.ts          typed fetch wrapper for the Core Backend REST API
    realtime/socket.ts     WebSocket client with topic subscribe + reconnect backoff
  store/uiStore.ts         Zustand store for client-only UI state
  types/domain.ts          draft shared types (Camera, FallEvent)
  styles/                  tokens.css (colors, sizes, dark mode), global.css (reset)
```

Rules:
1. `components/` contains nothing feature specific. If only one feature uses it, it lives in that feature folder.
2. Features may import from `components/`, `services/`, `store/`, `types/`, `config/`. Features do not import from each other.
3. Only `services/` knows URLs and transport details.

## 4. Component structure

```
App
 └─ RouterProvider
     └─ AppLayout            (route "/")
         ├─ skip link
         ├─ Header           brand, mobile menu toggle, notifications, account
         ├─ Navigation       grouped links from NAV_ITEMS; drawer < 1024px, sidebar >= 1024px
         ├─ MainContainer    <main>, max width 1440px, responsive padding
         │    └─ Suspense → <Outlet/>  (the lazy page)
         └─ Footer           project label, version, prototype notice
```

Page pattern: `PageHeader` (title, description, actions) followed by content or `EmptyState`.

## 5. Routing strategy

| Path | Page | Nav group |
|---|---|---|
| `/` | redirect to `/live` | |
| `/live` | Live View | Monitor |
| `/events` | Fall Events | Monitor |
| `/analytics` | Analytics | Monitor |
| `/cameras` | Cameras | Manage |
| `/detection` | Detection Settings | Manage |
| `/settings` | Settings | System |
| `*` | Not Found | |

- All pages are children of `AppLayout`, so the shell renders once and persists across navigation.
- Each page is code split through `lazy` and shown inside `Suspense`.
- Routes are generated from `NAV_ITEMS`, so adding a page means adding one entry there.
- Planned: `/events/:eventId`, `/cameras/:cameraId`, `/login`, and an auth guard layout route once Module 2 provides authentication.

## 6. State management strategy

| Kind of state | Where | Example |
|---|---|---|
| UI state (client only) | Zustand `uiStore`, persisted to localStorage where useful | nav drawer open, sidebar collapsed, theme |
| Server state | Fetched via `services/api`; cache layer proposed (TanStack Query) | cameras, events |
| Real-time updates | `services/realtime` pushes into the server-state cache | new fall event, camera status change |
| URL state | React Router search params | filters, date ranges, selected camera |
| Local component state | `useState` | form inputs, open menus |

Server data is never copied into Zustand. This keeps one owner per piece of data.

## 7. Integration with the Core Backend (Module 2)

- REST base URL: `VITE_API_BASE_URL`. WebSocket URL: `VITE_WS_URL`. See `.env.example`.
- The REST paths, WebSocket message shape (`{ topic, payload }`), and domain field names in `types/domain.ts` are placeholders. [TEAM CONFIRMATION REQUIRED] with the Module 2 owner.
- Live video: browsers cannot play RTSP directly. The Streaming Module must expose a browser-playable format (for example WebRTC or HLS). [OPEN DESIGN DECISION] with the Module 3 owner.

## 8. Responsive design

Breakpoints: below 640px (phone), 640 to 1023px (tablet), 1024px and above (desktop).
- Below 1024px: navigation is an off-canvas drawer opened from the header, closed by scrim click, Escape, or navigating.
- 1024px and above: fixed sidebar, collapsible to a 64px icon rail (persisted).
- Camera grid uses `auto-fill, minmax(min(100%, 320px), 1fr)`, so it goes from one to several columns with no media queries.
- Verified at 375px, 820px and 1366px widths: no horizontal scroll, no console errors (headless Chromium, 2026-10-12).

## 9. Accessibility baseline

Semantic landmarks (`header`, `nav`, `main`, `footer`), skip-to-content link, `aria-expanded` / `aria-controls` on the menu toggle, `aria-current` from `NavLink`, visible focus rings, reduced-motion support, light and dark themes. A formal accessibility audit has not been done.

## 10. Onboarding (new developer, under one day)

1. `npm install`, `cp .env.example .env`, `npm run dev`.
2. Read this file, then `config/navigation.ts` and `components/layout/AppLayout.tsx`.
3. To add a page: create `features/<area>/<Area>Page.tsx` with a default export, add one entry to `NAV_ITEMS`. Done.
4. Before pushing: `npm run build` (type check + build) and `npm run lint`.

## 11. Open decisions

| # | Decision | Needed from |
|---|---|---|
| 1 | Browser video format from the Streaming Module (WebRTC, HLS, MJPEG) | Module 3 |
| 2 | REST endpoints, WebSocket message schema, auth method | Module 2 |
| 3 | Adopt TanStack Query for server state | Team |
| 4 | Content of Detection Settings (prompt-based rules are an open design decision) | Team |
| 5 | Whether severity labels appear in the UI (severity classification is proposed, not validated) | Team |
| 6 | Supported browser list for CAP-29 "all supported browsers" | Team |
