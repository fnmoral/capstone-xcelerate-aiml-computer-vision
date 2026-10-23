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
| `DELETE /api/cameras/:id` | Removed from the gateway and the database (its incidents are kept) |
| `POST /api/cameras/:id/pause` · `/resume` | Stops / restarts the camera's stream on the gateway |
| `GET /api/cameras/:id/stream` · `/frame.jpg` | Annotated live video (MJPEG) / one frame, from ml-service |
| `GET /api/zones` | Zones and their cameras |
| `GET /api/incidents?status=&severity=&camera_id=&zone=&alert_status=&from=&to=&limit=` | Incidents, newest first, with their cameras and alert (who acknowledged / closed it, and when). `alert_status=none`: no alert. Times RFC 3339 |
| `GET /api/incidents/:id` | One incident + its prediction timeline + `activity` (who did what to it and its alert) |
| `PATCH /api/incidents/:id` | `{status?, notes?}` |
| `GET /api/alerts?status=` | Alerts |
| `POST /api/alerts/:id/acknowledge` · `/resolve` · `/false-positive` | Alert workflow; a false positive also marks its incident |
| `GET /api/notifications` | Open fall alerts + cameras that stopped working with `alert_offline` on (the header bell) |
| `GET /api/logs?kind=&camera_id=&incident_id=&from=&to=&limit=` | Activity log, newest first: user actions (`audit_logs`) and camera changes the monitor noticed (`system_logs`). `kind`: alert, incident, camera |
| `GET /api/export/incidents.csv?…` · `/api/export/logs.csv?…` | CSV downloads with the same filters, plus `tz` (IANA zone, e.g. `America/Toronto`) for the times |
| `GET /api/stats` | Dashboard / Analytics numbers |
| `GET /api/snapshots/:name` | Incident photo (from ml-service) |
| `GET /api/detection` | ml-service's detection settings (read-only) |
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
