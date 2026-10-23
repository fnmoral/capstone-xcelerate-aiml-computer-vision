-- Multi-tenant video AI platform schema (PostgreSQL 15+)
-- DB1 = config/identity (low volume, relational)
-- DB2 = events/alerts/logs (high volume, time-partitioned)
-- Vector DB = embeddings only (pgvector shown; swap for Qdrant/Milvus if needed)
--
-- Changes for the ML service (ml-service) integration:
--   * zones + cameras.zone_id: cameras that see the same area, so one fall = one incident
--   * incidents.zone + incident_cameras: every camera that saw an incident
--   * create_monthly_partitions() + DEFAULT partitions: inserts no longer fail when a
--     month has no partition yet (only 2026-10 existed)
--   * pgcrypto dropped: gen_random_uuid() is built into PostgreSQL 13+
--   * row-level security on the new tables and on model_predictions
--
-- Changes for the backend API (activity log, camera monitor):
--   * indexes on audit_logs and system_logs for the activity log / Camera Logs page.
--     Optional on an existing database (queries work without them).
--   * cameras.status is kept current by the API; cameras.metadata holds status_since and
--     alert_offline (notify when the camera stops working; default true)

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;     -- only needed if using pgvector

-- =====================================================================
-- DB1: USERS, TENANTS, CONFIGS
-- =====================================================================

CREATE TABLE tenants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    slug          CITEXT NOT NULL UNIQUE,
    plan          TEXT NOT NULL DEFAULT 'free',
    max_cameras   INT  NOT NULL DEFAULT 5,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          CITEXT NOT NULL UNIQUE,
    password_hash  TEXT,                       -- null if SSO only
    full_name      TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user can belong to several tenants, with a role in each
CREATE TABLE memberships (
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,         -- store hash only, never the key
    scopes       TEXT[] NOT NULL DEFAULT '{}',
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (                        -- optional; can live in Redis only
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Cameras and gateways ----------

CREATE TABLE sites (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    timezone   TEXT NOT NULL DEFAULT 'UTC',
    UNIQUE (tenant_id, name)
);

CREATE TABLE gateways (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id       UUID REFERENCES sites(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    auth_token_hash TEXT NOT NULL,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cameras that see the same area. A fall seen by several cameras of one zone is recorded
-- as one incident (ml-service merges them). A camera belongs to at most one zone.
CREATE TABLE zones (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id    UUID REFERENCES sites(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,                  -- e.g. 'Ward A', shown on incidents
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE cameras (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
    gateway_id      UUID REFERENCES gateways(id) ON DELETE SET NULL,
    zone_id         UUID REFERENCES zones(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    rtsp_url_enc    BYTEA NOT NULL,            -- encrypted, URLs often contain credentials
    status          TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','error','disabled')),
    keyframe_interval_s  INT NOT NULL DEFAULT 2,   -- Module 3 setting
    resolution      TEXT,
    location        TEXT,                      -- e.g. '2nd floor hallway', shown on alerts and reports
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
CREATE INDEX idx_cameras_tenant ON cameras(tenant_id);
CREATE INDEX idx_cameras_zone ON cameras(zone_id) WHERE zone_id IS NOT NULL;

-- ---------- Prompts and detection rules (Module 1 input) ----------

-- What the user types: "alert me if someone enters the loading dock after 6pm"
CREATE TABLE rules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    prompt_text   TEXT NOT NULL,                -- raw natural-language prompt
    parsed_config JSONB NOT NULL DEFAULT '{}',  -- structured form after orchestration/LLM parsing
    severity      TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
    schedule      JSONB,                        -- e.g. active hours / days
    is_enabled    BOOLEAN NOT NULL DEFAULT true,
    version       INT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rule_cameras (                     -- which cameras a rule applies to
    rule_id    UUID NOT NULL REFERENCES rules(id)   ON DELETE CASCADE,
    camera_id  UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, camera_id)
);

CREATE TABLE notification_channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('email','sms','webhook','slack')),
    target_enc  BYTEA NOT NULL,
    is_enabled  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rule_channels (
    rule_id     UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    channel_id  UUID NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, channel_id)
);

-- =====================================================================
-- DB2: EVENTS, ALERTS, LOGS (partitioned by month on time)
-- No cross-DB foreign keys: tenant_id/camera_id/rule_id are plain UUIDs
-- =====================================================================

-- Every processed keyframe (metadata only; the image lives in object storage)
CREATE TABLE frames (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL,
    camera_id     UUID NOT NULL,
    captured_at   TIMESTAMPTZ NOT NULL,
    object_key    TEXT NOT NULL,                -- path in object storage
    width         INT,
    height        INT,
    PRIMARY KEY (id, captured_at)
) PARTITION BY RANGE (captured_at);
CREATE INDEX idx_frames_cam_time ON frames (tenant_id, camera_id, captured_at DESC);

-- Detections produced by Module 4 (objects, people, actions)
CREATE TABLE events (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL,
    camera_id     UUID NOT NULL,
    frame_id      UUID,
    occurred_at   TIMESTAMPTZ NOT NULL,
    event_type    TEXT NOT NULL,                -- 'person','vehicle','intrusion','caption', ...
    confidence    REAL,
    caption       TEXT,                         -- VLM description of the scene
    detections    JSONB NOT NULL DEFAULT '[]',  -- boxes, labels, attributes
    model_version TEXT,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_events_cam_time  ON events (tenant_id, camera_id, occurred_at DESC);
CREATE INDEX idx_events_type_time ON events (tenant_id, event_type, occurred_at DESC);

-- A rule matched: this is what the user actually sees
CREATE TABLE alerts (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rule_id         UUID,                       -- null if raised directly by a model
    camera_id       UUID NOT NULL,
    event_id        UUID,                       -- soft link to events
    incident_id     UUID,                       -- soft link to incidents
    triggered_at    TIMESTAMPTZ NOT NULL,
    severity        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','false_positive')),
    summary         TEXT,
    snapshot_key    TEXT,                       -- object storage key
    acknowledged_by UUID,
    acknowledged_at TIMESTAMPTZ,
    PRIMARY KEY (id, triggered_at)
) PARTITION BY RANGE (triggered_at);
CREATE INDEX idx_alerts_open ON alerts (tenant_id, status, triggered_at DESC);
CREATE INDEX idx_alerts_incident ON alerts (incident_id);

CREATE TABLE alert_deliveries (                 -- did the email/webhook actually go out?
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    alert_id    UUID NOT NULL,
    channel_id  UUID NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
    attempts    INT NOT NULL DEFAULT 0,
    error       TEXT,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, sent_at)
) PARTITION BY RANGE (sent_at);

CREATE TABLE audit_logs (                       -- who did what (security/compliance)
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id   UUID,
    user_id     UUID,
    action      TEXT NOT NULL,                  -- 'rule.create','camera.delete','login', ...
    target_type TEXT,
    target_id   UUID,
    ip          INET,
    details     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Backend API: alert / incident / camera actions; details.actor is who did it
CREATE INDEX idx_audit_tenant_time ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_target      ON audit_logs (target_type, target_id, created_at);

CREATE TABLE system_logs (                      -- pipeline health: stream drops, GPU errors
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id   UUID,
    camera_id   UUID,
    module      TEXT NOT NULL,                  -- 'm3_stream','m4_gpu', ...
    level       TEXT NOT NULL,
    message     TEXT NOT NULL,
    context     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Backend API camera monitor (module 'camera'): not working, back online, paused, ...
CREATE INDEX idx_syslog_cam_time ON system_logs (tenant_id, module, camera_id, created_at DESC);

-- One row per fall: when it was detected, when the person recovered, how long they were down
-- A fall seen by several cameras of one zone is ONE row: camera_id is the first camera that
-- confirmed it; incident_cameras lists all of them.
CREATE TABLE incidents (
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    camera_id        UUID NOT NULL,             -- first camera that confirmed the fall
    zone             TEXT,                      -- zone name at the time (zones.name), null if the camera has none
    incident_type    TEXT NOT NULL DEFAULT 'fall',
    started_at       TIMESTAMPTZ NOT NULL,      -- fall first detected
    recovered_at     TIMESTAMPTZ,               -- person back on their feet, null while still down
    duration_seconds INT GENERATED ALWAYS AS
                     (EXTRACT(EPOCH FROM (recovered_at - started_at))::int) STORED,
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','recovered','unresolved','false_positive')),
    severity         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (severity IN ('low','medium','high','critical')),
    peak_confidence  REAL,                      -- highest fall confidence from the model
    location_label   TEXT,                      -- copy of cameras.location at the time
    snapshot_key     TEXT,                      -- object storage key for the key image
    clip_key         TEXT,                      -- object storage key for a short clip
    notes            TEXT,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX idx_incidents_cam_time ON incidents (tenant_id, camera_id, started_at DESC);
CREATE INDEX idx_incidents_status   ON incidents (tenant_id, status, started_at DESC);

-- Every camera (and tracked person on it) that saw an incident, with its own snapshot.
-- Low volume, so not partitioned.
CREATE TABLE incident_cameras (
    tenant_id     UUID NOT NULL,
    incident_id   UUID NOT NULL,                -- soft link to incidents
    camera_id     UUID NOT NULL,
    track_id      INT  NOT NULL,                -- ML tracker ID of the person on that camera
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot_key  TEXT,                         -- object storage key for this camera's image
    PRIMARY KEY (incident_id, camera_id, track_id)
);
CREATE INDEX idx_incident_cameras_cam ON incident_cameras (tenant_id, camera_id, joined_at DESC);

-- Raw ML output per inference, so reports and model reviews can trace back to the numbers
CREATE TABLE model_predictions (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL,
    camera_id     UUID NOT NULL,
    frame_id      UUID,
    incident_id   UUID,                         -- set once the prediction is grouped into an incident
    predicted_at  TIMESTAMPTZ NOT NULL,
    model_name    TEXT NOT NULL,
    model_version TEXT NOT NULL,
    label         TEXT NOT NULL,                -- ml-service: 'upright','falling','lying'
    confidence    REAL NOT NULL,
    output        JSONB NOT NULL DEFAULT '{}',  -- keypoints, torso angle, anything the model returns
    inference_ms  INT,
    PRIMARY KEY (id, predicted_at)
) PARTITION BY RANGE (predicted_at);
CREATE INDEX idx_pred_incident ON model_predictions (incident_id, predicted_at);
CREATE INDEX idx_pred_cam_time ON model_predictions (tenant_id, camera_id, predicted_at DESC);

-- Incident reports (generated summary, optional PDF in object storage)
CREATE TABLE reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL,
    incident_id   UUID NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generated','reviewed')),
    title         TEXT NOT NULL,
    summary       TEXT,
    content       JSONB NOT NULL DEFAULT '{}',  -- structured data used to build the report
    file_key      TEXT,                         -- PDF in object storage
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by   UUID,
    reviewed_at   TIMESTAMPTZ
);
CREATE INDEX idx_reports_incident ON reports (tenant_id, incident_id);

-- ---------- Monthly partitions ----------
-- create_monthly_partitions(from_month, months) creates <table>_YYYY_MM for every partitioned
-- table. ml-service calls it at startup for the current and next month; it can also run
-- from a monthly cron job. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION create_monthly_partitions(from_month date, months int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    t text;
    m date;
BEGIN
    FOREACH t IN ARRAY ARRAY['frames', 'events', 'alerts', 'alert_deliveries', 'audit_logs',
                             'system_logs', 'incidents', 'model_predictions'] LOOP
        FOR i IN 0 .. months - 1 LOOP
            m := (date_trunc('month', from_month) + make_interval(months => i))::date;
            EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                           t || '_' || to_char(m, 'YYYY_MM'), t, m, (m + interval '1 month')::date);
        END LOOP;
    END LOOP;
END $$;

-- Oct 2026 (seed data) through Jan 2027.
SELECT create_monthly_partitions(date '2026-10-01', 4);

-- Safety net: rows outside every monthly partition land here instead of failing the insert.
-- Create monthly partitions ahead of time, though: a month can't be split off the default
-- partition later while it holds rows for that month.
CREATE TABLE frames_default            PARTITION OF frames            DEFAULT;
CREATE TABLE events_default            PARTITION OF events            DEFAULT;
CREATE TABLE alerts_default            PARTITION OF alerts            DEFAULT;
CREATE TABLE alert_deliveries_default  PARTITION OF alert_deliveries  DEFAULT;
CREATE TABLE audit_logs_default        PARTITION OF audit_logs        DEFAULT;
CREATE TABLE system_logs_default       PARTITION OF system_logs       DEFAULT;
CREATE TABLE incidents_default         PARTITION OF incidents         DEFAULT;
CREATE TABLE model_predictions_default PARTITION OF model_predictions DEFAULT;

-- =====================================================================
-- VECTOR DB (Module 5): embeddings only, metadata stays in DB2
-- =====================================================================

CREATE TABLE frame_embeddings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL,
    camera_id    UUID NOT NULL,
    frame_id     UUID NOT NULL,                 -- links back to DB2.frames
    event_id     UUID,
    captured_at  TIMESTAMPTZ NOT NULL,
    embedding    vector(512) NOT NULL,          -- match your model's dimension (CLIP = 512/768)
    model_version TEXT NOT NULL
);
CREATE INDEX idx_emb_hnsw ON frame_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_emb_tenant ON frame_embeddings (tenant_id, camera_id, captured_at DESC);

-- =====================================================================
-- TENANT ISOLATION (row-level security, enable on every tenant table)
-- App sets:  SET app.tenant_id = '<uuid>';  at the start of each request
-- =====================================================================

ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cameras
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rules
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alerts
    USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON incidents
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reports
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zones
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE incident_cameras ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON incident_cameras
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE model_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_predictions
    USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- repeat for sites, gateways, api_keys, notification_channels, frames, etc.

-- =====================================================================
-- ML SERVICE ROLE (optional, recommended for production)
-- ml-service only needs to write detections and read camera/zone setup. It sets
-- app.tenant_id per transaction, so row-level security applies to it too.
-- =====================================================================
-- CREATE ROLE ml_service LOGIN PASSWORD '<from a secret store>';
-- GRANT SELECT ON tenants, cameras, zones, rules TO ml_service;
-- GRANT SELECT, INSERT, UPDATE ON incidents, incident_cameras, alerts TO ml_service;
-- GRANT INSERT ON model_predictions TO ml_service;
-- GRANT EXECUTE ON FUNCTION create_monthly_partitions(date, int) TO ml_service;  -- also needs CREATE on the schema
-- RLS also needs policies on tenants/cameras/rules or a SECURITY DEFINER lookup if ml_service reads them under RLS.
