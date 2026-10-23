# backend-module database

PostgreSQL 15+ schema for the platform, plus dev seed data.

| File | What it is |
|---|---|
| `schema.sql` | All tables: DB1 (tenants, users, cameras, zones, rules), DB2 (frames, events, alerts, incidents, model predictions, logs; partitioned by month), vector embeddings, row-level security |
| `seed.sql` | Dev data (PROD_MODE=false) with fixed UUIDs: tenant `demo-facility`, 3 sample cameras, a sample week of 10 incidents with alerts, label timelines, who handled them and notes. All timestamps are relative to when it runs (always the 7 days before), in one transaction. Not for production |
| `fall_detection_db_mockup.html` | Visual mock-up of the fall-detection tables |

## Run it with Docker (recommended)

[`../docker-compose.yml`](../docker-compose.yml) starts PostgreSQL 17 + pgvector
(`pgvector/pgvector:0.8.7-pg17`) and sets it up on first start.

```bash
cd backend-module
cp .env.example .env          # set POSTGRES_PASSWORD and ML_SERVICE_PASSWORD
docker compose up -d
docker compose logs -f db     # wait for "database system is ready to accept connections"
```

| Service | What it does |
|---|---|
| `db` | The database. On first start (empty volume) it runs, in order: `schema.sql`, `init/02-seed.sh` (loads the sample data `seed.sql` when `PROD_MODE=false` in the root `.env`; in prod, or with `PROD_MODE` unset, only the tenant and its fall rule; `SEED_DEMO_DATA=true/false` overrides), `init/03-roles.sh` (creates the restricted `ml_service` login) |
| `partitions` | Runs `create_monthly_partitions()` as the table owner at start and then daily, keeping `PARTITION_MONTHS_AHEAD` (3) months ready |

**Connecting from other containers.** The file creates a Docker network named
`fallguard`. Any other compose project joins it and reaches the database as `db:5432`
(or `postgres:5432`):

```yaml
services:
  my-service:
    environment:
      DATABASE_URL: postgresql://<user>:<password>@db:5432/fallguard
    networks: [fallguard]

networks:
  fallguard:
    name: fallguard       # fixed name: whichever project starts first creates it, the rest join
```

`ml-service/deploy/docker-compose.yml` already does this; its `ML_DATABASE_URL` is
`postgresql://ml_service:<ML_SERVICE_PASSWORD>@db:5432/fallguard`. URL-encode special
characters in passwords (`@` → `%40`, `:` → `%3A`).

**From your machine** (psql, a DB tool, ml-service run outside Docker): `localhost:5432`.
The port is bound to `127.0.0.1` only; set `DB_BIND=0.0.0.0` in `.env` to open it to the network.

| Task | Command |
|---|---|
| Open psql | `docker compose exec db psql -U fallguard_admin fallguard` |
| Reset after a schema change | `docker compose down -v && docker compose up -d` (deletes all data) |
| Stop, keep data | `docker compose down` |

The init scripts only run when the data volume is empty. Once the database holds data you
want to keep, schema changes need migrations instead of a reset.

## Load it without Docker

```bash
createdb fallguard
psql -v ON_ERROR_STOP=1 -f schema.sql fallguard
psql -v ON_ERROR_STOP=1 -f seed.sql   fallguard   # dev only
```

Needs the `citext` and `vector` (pgvector) extensions: a PostgreSQL install with contrib
plus pgvector.

## What ml-service writes

ml-service (the fall detector) writes these tables directly; see
[ml-service/CONFIG.md](../../ml-service/CONFIG.md#database).

| Table | Written when |
|---|---|
| `incidents` | A fall is confirmed (insert), its severity rises, and it closes (`recovered` / `unresolved`) |
| `incident_cameras` | Each camera, and tracked person on it, that saw an incident, with its snapshot |
| `alerts` | One per incident, `status = 'open'`, linked to the tenant's enabled fall rule if there is one. ml-service keeps `severity` and `summary` current but never changes `status`; that belongs to the people handling it |
| `model_predictions` | About once per second per tracked person; `incident_id` is set while the person is part of an incident |

It reads `tenants` (slug → id), `cameras` (name → id, `location`), `zones` and `rules`.

## Changes made for the ml-service integration

- **`zones` table + `cameras.zone_id`**: cameras that see the same area. A fall seen by
  several cameras of one zone is one incident. ml-service loads zones from here at startup.
- **`incidents.zone` + `incident_cameras` table**: an incident lists every camera that saw
  it. `incidents.camera_id` is the first camera that confirmed the fall.
- **`create_monthly_partitions(from_month, months)` + DEFAULT partitions.** Only 2026-10
  partitions existed, so every insert would have failed from 1 November. The schema now
  creates Oct 2026 – Jan 2027, and a DEFAULT partition catches anything outside them.
  With Docker Compose the `partitions` service runs it daily. Without it, **run the
  function monthly** (cron / pg_cron) as the table owner, e.g.
  `SELECT create_monthly_partitions(date_trunc('month', now())::date, 2);`. ml-service
  also calls it at startup, which works only if it connects as the table owner.
- **`pgcrypto` removed**: `gen_random_uuid()` is built into PostgreSQL 13+.
- **Row-level security** added on `zones`, `incident_cameras` and `model_predictions`.
- **Seed**: prediction labels now match ml-service (`upright`, `falling`, `lying`);
  CAM-02 and CAM-03 share the zone *Ground floor living area*; `incident_cameras` rows added.
- A suggested **`ml_service` role** with only the grants it needs is at the end of
  `schema.sql`; `init/03-roles.sh` creates it in the Docker setup.

## Row-level security

Policies compare `tenant_id` with `current_setting('app.tenant_id')`. Every request must
run `SELECT set_config('app.tenant_id', '<tenant uuid>', true)` in its transaction
(ml-service does this for every write). Without it, queries on those tables fail. Table
owners and superusers bypass RLS, so connect the application with a separate role.

## Camera IDs

gateway-back gives each camera a UUID in its own SQLite database; those cameras are not in
this `cameras` table yet. ml-service stores whatever ID it receives: a UUID as-is, a
`cameras.name` mapped to that camera's id, anything else mapped to a stable derived UUID.
Registering gateway cameras here (same UUID) is what links detections to camera names,
locations and zones.
