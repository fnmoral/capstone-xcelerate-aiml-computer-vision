# FallGuard Vision: Module 1 Frontend Architecture

Jira: CAP-27 (architecture), CAP-29 (basic components), API services task. Parent: CAP-21 Module 1 - Front-end.
Status: **Draft for team review** (approval pending). Owner: Berkin Öztürk. Last updated: 2026-11-20
(accounts and roles, notifications, incident reports, demo links, branding; screenshots in section 13).

## 1. Scope

Module 1 is the web interface of FallGuard Vision. It lets users sign in to their organization, watch live camera video
with fall-detection boxes, review fall events and their video clips, write incident reports
(WSIB / OHSA / OSHA / internal), manage cameras, members and roles, set up notifications, view
analytics, export reports, and adjust settings.

It talks to two services, and only through `src/services/`:

| Service | Used for | Transport |
|---|---|---|
| Core backend API (Module 2, `backend-module/api`) | All data: accounts and sessions, cameras, incidents, alerts, notes, stats, settings, members and roles, notifications, incident reports, CSV exports | REST under `/api` (session cookie), polled |
| stream-hub (Module 3) | Live video with detections, fall clips, snapshots | WebSocket and HTTP under `/stream-hub` (nginx lets it through only with a valid session) |

It never connects to cameras, the gateway, the ML service or the database directly.

| Item | Status |
|---|---|
| App shell (header, navigation, main container, footer) | IMPLEMENTED (CAP-29) |
| Routing for all sections, lazy loaded, each guarded by a permission | IMPLEMENTED |
| Sign-in, sign-up (organization), email verification (can be switched off), forgot / reset password, invitations | IMPLEMENTED (`features/auth`) |
| Roles admin / member / viewer, permission table editable by admins, demo access links (view-only, timed, QR code) | IMPLEMENTED (`features/members`) |
| Notifications page (severity x channel, recipients, follow-ups, templates, SMTP / Twilio with test buttons) | IMPLEMENTED (`features/notifications`) |
| Incident reports: WSIB Form 7, OHSA notice, OSHA 301, internal; auto-filled, draft / final, print / PDF | IMPLEMENTED (`features/incident-reports`) |
| Branding: FallGuard Vision logos (light / dark), loading screen, "Powered by Xcelerate Industries" | IMPLEMENTED (`components/ui/Brand.tsx`, `public/brand/`) |
| Responsive layout (mobile drawer, desktop sidebar, collapsible rail) | IMPLEMENTED |
| Light / dark / system theme | IMPLEMENTED |
| REST services | IMPLEMENTED: `services/api/` (see section 7) |
| Live video | IMPLEMENTED: H.264 over the stream-hub WebSocket, decoded in the browser (WebCodecs), boxes drawn on a canvas; reconnects by itself and flags a frozen picture |
| Fall alerts in the app | IMPLEMENTED: header bell, alarm tone, desktop notification, blinking tab title |
| Camera management, events, analytics, reports and CSV export, camera logs, detection settings | IMPLEMENTED |
| Push channel for data (instead of polling) | NOT IMPLEMENTED: `services/realtime/socket.ts` is an unused stub |
| Authentication / multi-tenant UI | IMPLEMENTED: session cookie; each organization sees only its data; the activity log shows who did what; switch organization from the account menu |
| Automated tests | NOT IMPLEMENTED in this folder: checks are type check, lint and build, plus end-to-end API checks run against a test stack (see the root README, Testing) |

## 2. Technology

| Concern | Choice | Reason |
|---|---|---|
| Language / UI | TypeScript + React 19 | Confirmed in the Project Vision Document |
| Build tool | Vite 8 | Fast dev server, standard for React + TS |
| Routing | React Router 7 (data router) | Nested layouts, lazy routes, widely known |
| Client UI state | Zustand 5 | Small, no boilerplate, easy for new contributors |
| Server state | `usePolling` hook over the typed API service | No extra dependency; enough for the current page count |
| Live video | WebSocket + WebCodecs `VideoDecoder` + canvas | Low latency, and detections can be drawn on the exact frame they belong to |
| Styling | Plain CSS with design tokens (CSS variables), one CSS file per component or feature | No extra dependency; theming via variables |
| Lint | oxlint | Already configured |
| QR codes | `qrcode` | Small, no other dependencies; renders invitation / demo links for phone cameras |

## 3. Folder structure

```
src/
  main.tsx                 entry: mounts App, loads global styles
  app/
    App.tsx                AuthProvider + RouterProvider; applies the theme to <html>
    router.tsx             route table: public sign-in pages, then the app (RequireAuth) with
                           one permission-checked route per NAV_ITEMS entry
  config/
    navigation.ts          SINGLE source of truth for pages (path, label, icon, section, permission, lazy import)
    env.ts                 VITE_* settings (API and stream-hub base URLs)
  components/
    layout/                app shell: AppLayout, Header, Navigation, MainContainer, Footer,
                           NotificationsMenu (bell), UserMenu (account, switch organization), SidebarClock
    ui/                    reusable pieces: Icon, PageHeader, EmptyState, StatusBadge, TimeWindow,
                           Brand (BrandLogo, BrandMark, PoweredBy, BrandLoader), ShareLink (link + QR)
  features/                one folder per product area; each owns its page and local components
    live-view/             LiveViewPage, CameraGrid
      live/                the video player: WebSocket protocol, H.264 grouping, decoder,
                           frame timing, detection lookup, canvas drawing
    events/                EventsPage (list), IncidentPage (detail), IncidentVideos, Notes, Snapshot
    auth/                  AuthContext (session, can(), RequireAuth, RequirePermission, PERM keys),
                           sign-in / sign-up / verify / reset / invitation / demo-link pages
    members/               Members & Roles: members, invitations, permission table, demo links
    notifications/         Notifications page
    incident-reports/      form definitions + auto-fill (forms.ts), editor and print view, panels
    account/               My account (profile, password, sessions)
    shared/                public view-only incident video (share link)
    analytics/  reports/  cameras/  camera-logs/  detection/  settings/  not-found/
  services/
    api/client.ts          typed fetch wrapper: errors, timeout, URL builders
    api/fallguard.ts       one function per backend endpoint (the only place that knows paths)
    api/accounts.ts        accounts, members, roles, demo links, notifications, incident reports
    api/usePolling.ts      hook: fetch now and every N ms
    realtime/socket.ts     unused stub for a future push channel
  store/uiStore.ts         Zustand store for client-only UI state
  lib/
    format.ts              shared text and time formatting, label names
    alertSignal.ts         alarm tone, desktop notification, tab-title blink
  types/domain.ts          shared types matching the backend API responses
  styles/                  tokens.css (colors, sizes, dark mode), global.css (reset)
public/
  brand/                   logos (light and dark versions), Xcelerate Industries logo
  favicon.svg              the C4 mark
```

Rules:
1. `components/` contains nothing feature specific. If only one feature uses it, it lives in that feature folder.
2. Features may import from `components/`, `services/`, `store/`, `lib/`, `types/`, `config/`. Features do not import from each other.
3. Only `services/` knows URLs and transport details. Pages never call `fetch` themselves.

Checked on 2026-11-09: no feature imports another feature, and there is no `fetch` call outside `services/`.
Since then a few features reuse others on purpose: `auth` (the session and permission checks,
used everywhere), `incident-reports` (shown inside the incident page) and `members` (role
descriptions on My account). Keep new cross-feature imports to shared building blocks like these.

## 4. Component structure

```
App                          theme on <html>
 └─ AuthProvider             session from GET /api/auth/me (re-checked every minute)
     └─ RouterProvider
         ├─ public pages      /login /signup /verify-email /forgot-password /reset-password
         │                    /invite/:token /demo/:token /shared/:token
         └─ RequireAuth       loading screen (BrandLoader) → sign-in page if no session
             └─ AppLayout     (route "/")
         ├─ skip link
         ├─ Header           logo (C4 mark on phones), mobile menu toggle, notifications bell, account menu
         ├─ Navigation       grouped links from NAV_ITEMS the role may open; drawer < 1024px, sidebar >= 1024px
         ├─ MainContainer    <main>, max width 1440px, responsive padding
         │    └─ Suspense → <Outlet/>  (the lazy page)
         └─ Footer           project label, version, prototype notice, "Powered by Xcelerate Industries"
```

Page pattern: `PageHeader` (title, description, actions) followed by content or `EmptyState`.
Buttons that change something are shown only when the role allows it (`useAuth().can(PERM.x)`);
the API refuses the action anyway, so hiding is about clarity, not security.

## 5. Routing strategy

| Path | Page | Nav group |
|---|---|---|
| `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` | Account pages (public) | |
| `/invite/:token` | Accept an invitation (public) | |
| `/demo/:token` | Temporary access link ("demo link" in the code): view-only visitor, no account (public) | |
| `/shared/:token` | View-only incident video for an outside recipient (public) | |
| `/` | redirect to the first page the role may open (usually `/live`) | |
| `/live` | Live View | Monitor |
| `/events` | Fall Events | Monitor |
| `/events/:id` | Incident detail | (from Fall Events) |
| `/analytics` | Analytics | Monitor |
| `/reports` | Reports & Export | Monitor |
| `/cameras` | Cameras | Manage |
| `/camera-logs` | Camera Logs | Manage |
| `/detection` | Detection Settings | Manage |
| `/notifications` | Notifications | Manage |
| `/members` | Members & Roles | System |
| `/settings` | Settings | System |
| `/incident-reports/:id` | Incident report editor and print view | (from an incident) |
| `/account` | My account | (account menu) |
| `*` | Not Found | |

- All pages are children of `AppLayout`, so the shell renders once and persists across navigation.
- Each page is code split through `lazy` and shown inside `Suspense`.
- Routes are generated from `NAV_ITEMS`, so adding a page means adding one entry there.
- `RequireAuth` wraps the app; each page route is wrapped in `RequirePermission` with the
  permissions from its `NAV_ITEMS` entry, so a role without access sees a clear "no access"
  page instead of errors.

## 6. State management strategy

| Kind of state | Where | Example |
|---|---|---|
| Session (user, organization, role, permissions) | `AuthProvider` context (`useAuth()`), from `GET /api/auth/me` | who is signed in, `can('alerts.manage')` |
| UI state (client only) | Zustand `uiStore`, persisted to localStorage where useful | nav drawer open, sidebar collapsed, theme, Live View layout, cleared notifications |
| Server state | `usePolling(() => api.something(), intervalMs)` in the page that shows it | cameras, incidents, alerts, stats |
| Live video and detections | Inside `LiveStream` (not React state): frames and boxes change many times a second | current frame, detection for its timestamp |
| URL state | React Router params and search params | incident id, selected camera in Camera Logs |
| Local component state | `useState` | form inputs, open menus |

Server data is never copied into Zustand. This keeps one owner per piece of data.

Polling pauses while the browser tab is hidden, except the notifications bell, which keeps
polling so a new fall alert can sound in a background tab.

## 7. Services: integration with the backend

All HTTP goes through three files in `services/api/`:

- **`client.ts`**: `apiRequest<T>(path, init)` adds the base URL and JSON header, applies a
  15 s timeout, and turns every failure into an `ApiError` with a readable message (the
  backend's own `error` text when it sends one) and its `code`. A 401 "sign in to continue"
  fires an event that sends the user back to the sign-in page. The session is an HttpOnly
  cookie, so no token handling is needed in the browser. `apiUrl()` and `streamHubUrl()` build URLs
  for downloads, clips, snapshots and the video WebSocket.
- **`fallguard.ts`**: the `api` object, one typed function per endpoint. Pages call
  `api.cameras()`, `api.alertAction(id, 'acknowledge')` and so on; they never see a path.
- **`usePolling.ts`**: runs a service call now and on an interval; returns `{ data, error, loading, reload }`.

Endpoints in use (all exist in `backend-module/api`, checked 2026-11-09):

| Area | Endpoints |
|---|---|
| Health and stats | `GET /health`, `GET /stats` |
| Cameras | `GET/POST /cameras`, `PATCH/DELETE /cameras/:id`, `POST /cameras/:id/pause` / `resume` / `switch`, `PUT /cameras/order` |
| Incidents | `GET /incidents`, `GET/PATCH /incidents/:id`, `POST /incidents/:id/notes` |
| Alerts | `GET /alerts`, `POST /alerts/:id/acknowledge` / `resolve` / `false-positive` / `reopen`, `GET /notifications` |
| Logs and exports | `GET /logs`, `GET /export/incidents.csv`, `GET /export/logs.csv` |
| Settings | `GET/PUT /settings`, `GET/PUT /detection`, `GET/PUT /gateway/config`, `GET/PUT /org` |
| Accounts | `/auth/*`: signup, login, logout, verify-email, forgot / reset password, invitations, demo links, me, change-password, switch-org, config |
| Members and roles | `GET /org/members`, `/org/invitations`, `PATCH/DELETE /org/members/:id`, `GET/PUT /org/permissions`, `/org/guest-links` |
| Notifications | `/notification-settings` (+ `/email-provider`, `/sms-provider`, `/test-email`, `/test-sms`, `/preview`, `/deliveries`) |
| Incident reports | `/incidents/:id/report-facts`, `/incidents/:id/reports`, `/incident-reports/:id` |
| stream-hub | `WS /stream-hub/ws/:tenant/:camera?v=2`, `GET /stream-hub/recordings/clips/:name`, `GET /stream-hub/recordings/snapshots/:name` |

To add an endpoint: add its response type to `types/domain.ts`, add one function to `api` in
`fallguard.ts`, and call it from the page with `usePolling` (reads) or directly (actions).

Settings (the project's one `.env`, see `../.env.example`): `VITE_API_BASE_URL` (default `/api`), `VITE_STREAM_BASE_URL`
(default `/stream-hub`). In Docker, nginx forwards both paths; in `npm run dev`, the Vite
proxy does (`VITE_API_PROXY`, `VITE_STREAM_PROXY`).

The full list, with permissions, is in `backend-module/api/README.md`. Not yet in the service
layer: automatic retry.

## 8. Responsive design

Breakpoints: below 640px (phone), 640 to 1023px (tablet), 1024px and above (desktop).
- Below 1024px: navigation is an off-canvas drawer opened from the header, closed by scrim click, Escape, or navigating.
- 1024px and above: fixed sidebar, collapsible to a 64px icon rail (persisted).
- Camera grid uses `auto-fill, minmax(min(100%, 320px), 1fr)`, so it goes from one to several columns with no media queries.

Verified on 2026-11-09 in headless Chromium at 375px, 820px and 1366px, on all eight pages:
header, navigation, main and footer present; no horizontal scroll; no JavaScript errors.
(The backend was not running for this check, so it covers layout, not data.)

## 9. Supported browsers

[TEAM CONFIRMATION REQUIRED] The list below is a proposal, set by what live video needs.
The team still has to agree which browsers count as "supported" for CAP-29.

| Browser | Layout and data pages | Live video, alerts, clips |
|---|---|---|
| Chrome (current, macOS) | Verified manually, 2026-11-09 | Verified manually, 2026-11-09 |
| Safari (current, macOS) | Verified manually, 2026-11-09 | Verified manually, 2026-11-09 |
| Edge, Firefox, iOS Safari | [TO BE VERIFIED] | [TO BE VERIFIED] |

Manual check on 2026-11-09 (full Docker stack, MacBook built-in camera): live video with
detection boxes, fall alert with alarm tone, incident photo and clip playback, and the
frozen-video notice and reconnect after stopping and starting stream-hub.

Live video and desktop notifications only work on `https://` or `http://localhost`. Opening
the app as `http://<ip-address>` from another device shows the pages but not live video.

## 10. Accessibility baseline

Semantic landmarks (`header`, `nav`, `main`, `footer`), skip-to-content link, `aria-expanded` / `aria-controls` on the menu toggle, `aria-current` from `NavLink`, visible focus rings, reduced-motion support, light and dark themes, status badges that always carry text. A formal accessibility audit has not been done.

## 11. Onboarding (new developer, under one day)

1. Start the platform once with Docker (see `../GETTING_STARTED.md`).
2. In `fallguard-frontend`: `npm install`, then `npm run dev` and open http://localhost:5173.
   No settings are needed; to change a default, set it in the project's root `.env` (it reads only the `VITE_*` lines).
3. Read this file, then `config/navigation.ts`, `components/layout/AppLayout.tsx` and `services/api/fallguard.ts`.
4. To add a page: create `features/<area>/<Area>Page.tsx` with a default export, add one entry to `NAV_ITEMS`. Done.
5. To show backend data: add a function to `api` and use it with `usePolling` (section 7).
6. Before pushing: `npm run build` (type check + build) and `npm run lint`.

## 12. Open decisions

| # | Decision | Needed from |
|---|---|---|
| 1 | Approve this architecture (CAP-27 acceptance) | Team |
| 2 | Supported browser list (section 9) | Team |
| 3 | ~~Auth method and login flow~~ | Done: session cookie, sign-in / sign-up / invitations (Module 2) |
| 4 | Replace polling with a push channel, or remove the `services/realtime` stub | Team |
| 5 | Add automated tests (unit tests for `services/` and `live/`) | Team |
| 6 | Whether severity labels appear in the UI (they are based on time down only) | Team |
| 7 | Content of Detection Settings (prompt-based rules are an open design decision) | Team |

Resolved since the first draft: browser video format (H.264 over WebSocket, decoded with
WebCodecs) and the REST endpoints (section 7).

## 13. Screens

Captured 2026-11-20 with headless Chrome against a test stack with the demo data (a sample week
of falls). Photos and video clips show placeholders there because no camera was recording. All
files are in [`screenshots/`](screenshots/).

### Signing in

| Loading screen | Sign in | Create an organization |
|---|---|---|
| ![Loading](screenshots/00-loading.png) | ![Sign in](screenshots/01-sign-in.png) | ![Sign up](screenshots/02-sign-up.png) |

### Monitoring

| Live View | Fall Events | Analytics |
|---|---|---|
| ![Live View](screenshots/03-live-view.png) | ![Fall Events](screenshots/04-fall-events.png) | ![Analytics](screenshots/09-analytics.png) |

Incident detail (alert actions, history, notes, incident reports, share video):

![Incident](screenshots/05-incident.png)

### Incident reports

| Choose a form | WSIB Form 7 | Auto-filled from the records |
|---|---|---|
| ![Forms](screenshots/06-report-forms.png) | ![WSIB](screenshots/07-report-wsib.png) | ![Auto-filled](screenshots/08-report-wsib-autofilled.png) |

Reports & Export (incident log, activity log, and the incident reports of the filtered falls, printable one by one or all at once):

![Reports](screenshots/10-reports.png)

### Managing

| Cameras | Settings | My account |
|---|---|---|
| ![Cameras](screenshots/11-cameras.png) | ![Settings](screenshots/15-settings.png) | ![My account](screenshots/16-my-account.png) |

Notifications (severity x channel, recipients, follow-ups, templates, providers):

![Notifications](screenshots/12-notifications.png)

Members & Roles (members, invite a team member and temporary access links side by side, permission table) and a new temporary access link with its QR code:

| Members & Roles | Demo link with QR code |
|---|---|
| ![Members](screenshots/13-members-roles.png) | ![Demo link QR](screenshots/14-demo-link-qr.png) |

### Dark theme and demo visitor

| Fall Events (dark) | Incident (dark) | Demo visitor (view-only) |
|---|---|---|
| ![Dark events](screenshots/17-dark-fall-events.png) | ![Dark incident](screenshots/18-dark-incident.png) | ![Visitor](screenshots/19-demo-visitor.png) |

### Phone

| Sign in | Fall Events | Navigation | Incident |
|---|---|---|---|
| ![Phone sign in](screenshots/20-phone-sign-in.png) | ![Phone events](screenshots/21-phone-fall-events.png) | ![Phone nav](screenshots/22-phone-navigation.png) | ![Phone incident](screenshots/23-phone-incident.png) |
