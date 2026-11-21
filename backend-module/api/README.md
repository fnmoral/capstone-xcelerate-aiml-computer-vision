# Core backend API (Module 2)

Go (Gin + pgx) REST API that the FallGuard frontend talks to. Everything is under `/api`.
It reads the database, manages cameras through gateway-back (keeping the database's
`cameras` table in sync), and passes through live video, photos and detection settings
from ml-service.

| Route | Does |
|---|---|
| `GET /api/health` | Reachability and latency of database, gateway-back, stream-hub, ml-service |
| `GET /api/cameras` | Gateway cameras (status) + database details (name, location, zone) + live ML state (video arriving, people, active incidents) + `health` (online / paused / not_working / connecting / not_connected), `health_since`, `alert_offline`. Cameras added directly in the gateway UI are registered in the database here |
| `POST /api/cameras` | `{name, rtsp_url, username?, password?, location?, zone?}` → added on the gateway, registered in the database with the same UUID. Credentials stay on the gateway only |
| `PATCH /api/cameras/:id` | `{name?, location?, zone?, alert_offline?}` (database only; an empty zone clears it). `alert_offline`: notify when the camera stops working (default on) |
| `PUT /api/cameras/order` | `{camera_ids: [...]}`: the order cameras are shown in (Live View, incident videos); stored as `cameras.metadata.sort_order`. `GET /api/cameras` and incident cameras come back in this order |
| `DELETE /api/cameras/:id` | Removed from the gateway and the database (its incidents are kept) |
| `POST /api/cameras/:id/pause` · `/resume` | Stops / restarts the camera's stream on the gateway. The gateway streams at most 5 at once (resume: 409 at 5) and keeps up to 50; `GET /api/cameras` returns `limits`. A camera added while 5 stream is saved paused (`status: "paused"`) |
| `POST /api/cameras/:id/switch` | `{replace_id}`: stream this paused camera instead of `replace_id` (pauses that one, resumes this one; if this one fails, `replace_id` is resumed again) |
| `GET /api/cameras/:id/stream` · `/frame.jpg` | Annotated live video (MJPEG) / one frame, from ml-service |
| `GET /api/zones` | Zones and their cameras |
| `GET /api/incidents?status=&severity=&camera_id=&zone=&alert_status=&from=&to=&limit=` | Incidents, newest first, with their cameras and alert (who acknowledged / closed it, and when). `alert_status=none`: no alert. Times RFC 3339 |
| `GET /api/incidents/:id` | One incident + its prediction timeline + `activity` (who did what to it and its alert) |
| `PATCH /api/incidents/:id` | `{status?, notes?}` |
| `POST /api/incidents/:id/notes` | `{author?, text}`: append a note (several people can; none is overwritten). Stored in `audit_logs` (`incident.note`); incidents return them as `note_list`, the CSV export as one cell |
| `GET /api/alerts?status=` | Alerts |
| `POST /api/alerts/:id/acknowledge` · `/resolve` · `/false-positive` | Alert workflow; a false positive also marks its incident |
| `POST /api/alerts/:id/reopen` | Undo Resolve or False alarm (clicked by mistake): the alert goes back to open / acknowledged; after a false alarm the incident gets its previous status back. 409 if the alert isn't resolved or a false alarm. Logged as `alert.reopened` |
| `GET /api/notifications` | Open fall alerts + cameras that stopped working with `alert_offline` on (the header bell) |
| `GET /api/logs?kind=&camera_id=&incident_id=&from=&to=&limit=` | Activity log, newest first: user actions (`audit_logs`) and camera changes the monitor noticed (`system_logs`). `kind`: alert, incident, camera |
| `GET /api/export/incidents.csv?…` · `/api/export/logs.csv?…` | CSV downloads with the same filters, plus `tz` (IANA zone, e.g. `America/Toronto`) for the times |
| `GET /api/stats?tz=` | Dashboard / Analytics numbers. "Today" and `per_day` (local dates) are counted in `tz`, else the facility time zone, else UTC |
| `PUT /api/settings/theme` | `{theme: light / dark / system}`: the organization's default theme (people who chose their own keep it); `GET /api/settings` returns it as `theme` (null = light). Logged as `settings.theme` |
| `GET` · `PUT /api/settings` | Facility settings: `{timezone}` (IANA zone, or `null` = each browser's own). Used by the app for every time shown, stats and exports; logged as `settings.timezone` |
| `GET /api/snapshots/:name` | Incident photo (from ml-service) |
| `GET /api/clips/:name` | Incident video clip, MP4 (from ml-service; Range requests pass through for seeking). Incidents return `clip_key` and each camera's `clip_key` |
| `GET /api/detection` | ml-service's detection settings (what it runs with now) + `saved`: values set in the app |
| `PUT /api/detection` | `{person_confidence}` (0.05–0.95; `{}` = back to config.yaml). Stored in the fall rule's `parsed_config.detection`; ml-service applies it within 15 s. Logged as `settings.detection` |
| `GET` · `PUT /api/gateway/config` | gateway-back's settings (stream-hub address) |

## Accounts, roles and organizations

Every route except `/api/health*`, `/api/gateway/add` (gateway start-up) and the public
`/api/auth/*` routes below needs a signed-in session (HttpOnly cookie `fg_session`, 7 days,
extended while used). The session's organization is the tenant of every query
(`store.WithTenant`); its user is the actor in the activity log (`audit_logs.user_id` and
`details.actor`). Each route also checks a permission of the user's role
(`internal/auth/perms.go`): **admin** can do everything; **member** everything except
managing people and roles; **viewer** read-only. Admins can tick what members and viewers
may do (`tenants.role_permissions`); managing members and roles stays admin-only.

| Route | Does |
|---|---|
| `POST /api/auth/signup` | `{org_name, first_name, last_name, email, password}` → account + organization (the user is its admin) + verification email. One account per email (409). The **first** sign-up takes over the home tenant (`TENANT`: gateway, cameras, history); later ones get a new, empty organization |
| `POST /api/auth/verify-email` | `{token}` from the email link (48 h, once) → verified and signed in. Sign-in is refused until the email is verified |
| `POST /api/auth/login` · `/logout` · `/logout-all` | 5 wrong passwords lock the account for 15 min; unknown emails get the same answer as wrong passwords |
| `POST /api/auth/forgot-password` · `/reset-password` | Reset link (1 h, once); a reset signs out every session. Always answers ok |
| `POST /api/auth/resend-verification` | Always answers ok |
| `GET /api/auth/invitations/:token` · `POST …/accept` | Invitation page: new people set name + password (the link verifies the email); existing accounts confirm with their password and join a second organization |
| `GET` · `PATCH /api/auth/me` | User, organization, role, permissions, organizations; name and phone (E.164) |
| `POST /api/auth/change-password` · `/switch-org` · `/api/org/leave` | Changing the password signs out the other sessions |
| `GET /api/auth/check` | 204 / 401: nginx `auth_request` for `/stream-hub` (live video, clips, snapshots) |
| `GET /api/auth/config` | `{email_verification}`: whether sign-in needs a verified email (`REQUIRE_EMAIL_VERIFICATION`; false = signed in right after sign-up) |
| `GET` · `POST /api/auth/demo/:token` | Demo access link: info (organization, label, end time) / sign in as the link's view-only visitor until it ends. 404 once expired or ended |
| `GET` · `POST /api/org/guest-links` · `DELETE …/:id` | Admins: list / create (`{label, hours}` 1–720; the URL with its token is returned only now) / end a demo link (its visitors are signed out) |
| `GET` · `PUT /api/org` | Organization name and profile (address, WSIB firm number…; used by incident reports) |
| `GET /api/org/members` · `PATCH` · `DELETE /api/org/members/:id` | Members; change role / remove (signs them out). The last admin can't be demoted or removed (409) |
| `POST /api/org/invitations` · `…/:id/resend` · `DELETE …/:id` | Invite by email with a role (7 days); the answer also has the link (`url`) so the admin can share it directly (copy / QR code) |
| `GET` · `PUT /api/org/permissions` | Permission catalog and what members / viewers may do |

Organizations other than the home one have no gateway yet: adding, pausing or removing
cameras answers 409 `no_gateway` (ml-service still serves the home tenant only).

## Notifications

| Route | Does |
|---|---|
| `GET` · `PUT /api/notification-settings` | Severity × channel matrix (`app`, `email`, `sms` × medium / high / critical), email and SMS recipients (each with its severities), follow-ups (recovered, false alarm, resolved), templates per event (custom or default, `{{placeholders}}`), app address for links |
| `PUT /api/notification-settings/email-provider` · `/sms-provider` | `log` (default: messages go to the API log) or SMTP / Twilio. Passwords and tokens are stored encrypted (AES-GCM, `APP_SECRET`) and never returned |
| `POST /api/notification-settings/test-email` · `/test-sms` | Send a test with the saved or the unsaved (`provider`) settings; the error tells what failed |
| `POST /api/notification-settings/preview` · `GET …/deliveries` | Template preview with sample data; latest messages and their status |

`RunNotifier` checks every 5 s: each time an alert reaches a new severity it emails / texts
the recipients of that severity (once per alert and level, `notification_events`), then the
follow-ups to the people who got the alert. Failed messages are retried 3 times
(`notification_deliveries`). In-app: `GET /api/notifications` leaves out severities switched
off for the app. Account emails (verification, reset, invitations) use `SMTP_*` from the
environment, else the organization's (or home organization's) SMTP provider, else the log.

## Incident reports

| Route | Does |
|---|---|
| `GET /api/incidents/:id/report-facts` | Everything known about an incident for a report: incident, cameras, alert timeline, notes, organization profile, preparer |
| `POST /api/incidents/:id/reports` · `GET /api/incidents/:id/reports` | `{form, title, content}`; forms `wsib_form7`, `ohsa_notice`, `osha_301`, `internal`. The frontend fills the form's fields from the facts (`features/incident-reports/forms.ts`) |
| `GET /api/incident-reports` · `GET` · `PUT` · `DELETE /api/incident-reports/:id` | List / edit (`status` draft or final; final records who and when; reopening is logged as such) / delete. Delete moves the report to Recently deleted |
| `GET /api/incident-reports/deleted` · `POST /api/incident-reports/:id/restore` | Recently deleted reports (with `purge_at`) and restoring one. They are removed for good after the organization's `report_retention_days` (profile, default 14, 1–365), checked hourly |
| `GET` · `POST /api/incidents/:id/share-links` · `DELETE /api/share-links/:id` | View-only links to an incident's video for people without an account (regulators). `{recipient, days}` (1–90, default 14); the URL is returned once (only the token's hash is stored); delete = revoke |
| `GET /api/shared/:token` · `GET /api/shared/:token/media/:kind/:name` | Public (the token is the permission): the incident's time, place and outcome, and its clips / snapshots streamed from stream-hub (only that incident's files; seeking works). Each page view is counted and logged. Tokens are redacted from the API and nginx logs |

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgresql://fallguard_admin@localhost:5432/fallguard` | Docker Compose builds it from the root `.env` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`) |
| `TENANT` | `demo-facility` | Home tenant (`tenants.slug` or id): owns the gateway and ML pipeline; the first sign-up takes it over |
| `APP_URL` | (request address) | Web app address for links in emails |
| `APP_SECRET` | (key in the database) | Encrypts SMTP passwords / Twilio tokens saved in the app |
| `COOKIE_SECURE` | `false` | Session cookie over HTTPS only |
| `REQUIRE_EMAIL_VERIFICATION` | `true` | `false` = no verification email, new accounts are signed in at once (demos) |
| `EMAIL_LINKS_IN_RESPONSE` | `false` | Without an email provider, return verification / reset / invitation links in API answers (demos only) |
| `ALLOWED_ORIGINS` | | Other web origins allowed to send requests (same origin always is) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURITY` `SMTP_USERNAME` `SMTP_PASSWORD` `SMTP_FROM` `SMTP_FROM_NAME` | | Mail server for account emails |
| `GATEWAY_URL` | `http://localhost:8080` | `http://gateway-back:8080` in Docker |
| `ML_URL` | `http://localhost:8000` | ml-service viewer, `http://ml-service:8000` in Docker |
| `STREAM_HUB_URL` | `http://localhost:9000` | health check only |
| `API_ADDR` | `:8000` | listen address |

Every query sets `app.tenant_id` (the signed-in organization) in its transaction
(row-level security) and filters on it. It still connects as the table owner; a restricted
role is a later step.

## Who did what (activity log)

Acknowledge / resolve / false alarm, incident status and notes, and camera add / edit /
pause / resume / remove / alert setting are written to `audit_logs` (`action` such as
`alert.acknowledged`, `details.actor` = who, `details.message`), with `user_id` = the
signed-in user (`actor()` in `internal/api/auth.go`). Member, role, invitation, report and
notification-setting changes are logged the same way.

## Migrations

At start the API brings an existing database up to date (idempotent statements in
`internal/store/settings.go` and `migrations_accounts.go`), e.g. `incident_cameras.clip_key`
and the account, notification and report tables. New databases get the same
from `db/schema.sql`.

## Dev mode

With `PROD_MODE=false` (root `.env`) the API adds this PC's webcam to the gateway at start,
as "Windows webcam" (`rtsp://test-camera:8554/webcam`), when the gateway has no cameras at
all. Its video comes from `ml-service/setup_and_tools/fake_cameras/publish_webcam.py` on the PC, through the
test-camera relay (which dev starts with the stack). Prod never does this.

## Camera monitor

Every 5 s the API compares gateway-back (is the camera paused?) with ml-service (is its
video arriving?) and keeps `cameras.status` current: `online`, `disabled` (paused),
`error` (**not working**: on the gateway, not paused, no video for 20 s, or ml-service
unreachable), `offline` (not on the gateway). Each change is written to `system_logs`
(module `camera`) with a readable message, and `cameras.metadata.status_since` is set.
If gateway-back is unreachable it changes nothing (it can't tell paused from broken).
Cameras with `alert_offline` on that are not working appear in `/api/notifications`.

## Run

```bash
docker compose up -d api          # from backend-module/ (or the root stack)
curl http://localhost:8100/api/health
```

Locally: `go run ./cmd/api` with the variables above.
