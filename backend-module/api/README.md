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
| `GET /api/notifications` | Open fall alerts + cameras that stopped working with `alert_offline` on (the header bell) |
| `GET /api/logs?kind=&camera_id=&incident_id=&from=&to=&limit=` | Activity log, newest first: user actions (`audit_logs`) and camera changes the monitor noticed (`system_logs`). `kind`: alert, incident, camera |
| `GET /api/export/incidents.csv?…` · `/api/export/logs.csv?…` | CSV downloads with the same filters, plus `tz` (IANA zone, e.g. `America/Toronto`) for the times |
| `GET /api/stats?tz=` | Dashboard / Analytics numbers. "Today" and `per_day` (local dates) are counted in `tz`, else the facility time zone, else UTC |
| `GET` · `PUT /api/settings` | Facility settings: `{timezone}` (IANA zone, or `null` = each browser's own). Used by the app for every time shown, stats and exports; logged as `settings.timezone` |
| `GET /api/snapshots/:name` | Incident photo (from ml-service) |
| `GET /api/clips/:name` | Incident video clip, MP4 (from ml-service; Range requests pass through for seeking). Incidents return `clip_key` and each camera's `clip_key` |
| `GET /api/detection` | ml-service's detection settings (what it runs with now) + `saved`: values set in the app |
| `PUT /api/detection` | `{person_confidence}` (0.05–0.95; `{}` = back to config.yaml). Stored in the fall rule's `parsed_config.detection`; ml-service applies it within 15 s. Logged as `settings.detection` |
| `GET` · `PUT /api/gateway/config` | gateway-back's settings (stream-hub address) |

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgresql://fallguard_admin@localhost:5432/fallguard` | Docker Compose builds it from `backend-module/.env` |
| `TENANT` | `demo-facility` | `tenants.slug` or id served (no user accounts yet) |
| `GATEWAY_URL` | `http://localhost:8080` | `http://gateway-back:8080` in Docker |
| `ML_URL` | `http://localhost:8000` | ml-service viewer, `http://ml-service:8000` in Docker |
| `STREAM_HUB_URL` | `http://localhost:9000` | health check only |
| `API_ADDR` | `:8000` | listen address |

Every query sets `app.tenant_id` in its transaction (row-level security). For now it
connects as the table owner; once user accounts exist, give it its own restricted role.

## Who did what (activity log)

Acknowledge / resolve / false alarm, incident status and notes, and camera add / edit /
pause / resume / remove / alert setting are written to `audit_logs` (`action` such as
`alert.acknowledged`, `details.actor` = who, `details.message`). There are no user
accounts yet, so the actor is always **"Current user"**: `actor()` in
`internal/api/reports.go` is the one place to return the signed-in user later.

## Migrations

At start the API brings an existing database up to date (idempotent statements in
`internal/store/settings.go`), e.g. `incident_cameras.clip_key`. New databases get the same
from `db/schema.sql`.

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
