-- Dev seed data for fall detection (PROD_MODE=false). Run AFTER schema.sql. Never in production.
-- Fixed UUIDs so the front end, tests and ML code can refer to the same rows.
--
-- Every timestamp is relative to the moment the seed runs (pg_temp.ago('...') = now() minus that),
-- so the sample week is always the 7 days before the database was created. It all runs in
-- one transaction, so every ago() uses the same "now".

BEGIN;

CREATE FUNCTION pg_temp.ago(t text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - t::interval $$;

-- Monthly partitions for the sample week (it can start in the previous month).
SELECT create_monthly_partitions(date_trunc('month', now() - interval '7 days')::date, 3);

-- ---------- Tenant, users, roles ----------

INSERT INTO tenants (id, name, slug, plan, max_cameras)
VALUES ('11111111-1111-1111-1111-111111111111', 'Demo Facility', 'demo-facility', 'pro', 20);

INSERT INTO users (id, email, password_hash, full_name) VALUES
('22222222-2222-2222-2222-222222222221', 'admin@demo.com',    'dev-only-not-a-real-hash', 'Demo Admin'),
('22222222-2222-2222-2222-222222222222', 'operator@demo.com', 'dev-only-not-a-real-hash', 'Demo Operator');

INSERT INTO memberships (tenant_id, user_id, role) VALUES
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'owner'),
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'operator');

-- ---------- Site, gateway, cameras ----------
-- These three are sample cameras for the history below (database only, "Not connected").
-- In dev the API also adds a "Windows webcam" camera to the gateway (see the API README).

INSERT INTO sites (id, tenant_id, name, timezone)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        'Main Building', 'America/Toronto');

INSERT INTO gateways (id, tenant_id, site_id, name, auth_token_hash, last_seen_at)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'gateway-main-01', 'dev-only-token-hash', pg_temp.ago('1 hour'));

-- Cameras 02 and 03 both cover the ground floor living area, so a fall seen by both is one incident.
INSERT INTO zones (id, tenant_id, site_id, name)
VALUES ('99999999-9999-9999-9999-999999999901', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'Ground floor living area');

INSERT INTO cameras (id, tenant_id, site_id, gateway_id, zone_id, name, rtsp_url_enc, status,
                     keyframe_interval_s, resolution, location) VALUES
('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', NULL,
 'CAM-01 Hallway', 'placeholder'::bytea, 'offline', 2, '1920x1080', '2nd floor hallway'),
('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999901',
 'CAM-02 Living Room', 'placeholder'::bytea, 'offline', 2, '1920x1080', 'Ground floor living room'),
('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999901',
 'CAM-03 Bathroom Corridor', 'placeholder'::bytea, 'offline', 2, '1280x720', 'Ground floor bathroom corridor');

-- ---------- Rule and notification channels ----------

INSERT INTO rules (id, tenant_id, created_by, name, prompt_text, parsed_config, severity)
VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222221', 'Fall detection',
        'Alert me when a person falls and stays on the floor',
        '{"event_type":"fall","min_confidence":0.5,"escalate_after_seconds":60}', 'high');

INSERT INTO rule_cameras (rule_id, camera_id) VALUES
('55555555-5555-5555-5555-555555555555', 'c0000000-0000-0000-0000-000000000001'),
('55555555-5555-5555-5555-555555555555', 'c0000000-0000-0000-0000-000000000002'),
('55555555-5555-5555-5555-555555555555', 'c0000000-0000-0000-0000-000000000003');

INSERT INTO notification_channels (id, tenant_id, type, target_enc) VALUES
('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111', 'email',   'placeholder'::bytea),
('66666666-6666-6666-6666-666666666602', '11111111-1111-1111-1111-111111111111', 'webhook', 'placeholder'::bytea);

INSERT INTO rule_channels (rule_id, channel_id) VALUES
('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666601'),
('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666602');

-- ---------- Incidents: a sample week ----------
--  1  6d  quick self recovery (8 s)              7  1d  long time down (95 s), acknowledged only
--  2  6d  long time on the floor (142 s)         8  1d  false alarm (a coat on a chair)
--  3  5d  false alarm (bending down)             9  6h  quick recovery, alert still open
--  4  4d  seen by two cameras of a zone (35 s)  10  2h  recovery after 25 s, alert still open
--  5  3d  went out of view while down
--  6  2d  recovery after 20 s

INSERT INTO incidents (id, tenant_id, camera_id, zone, incident_type, started_at, recovered_at,
                       status, severity, peak_confidence, location_label, snapshot_key) VALUES
('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'Ground floor living area', 'fall', pg_temp.ago('6 days 14 hours'), pg_temp.ago('6 days 14 hours') + interval '8 seconds',
 'recovered', 'medium', 0.91, 'Ground floor living room', 'demo-facility/sample-1.jpg'),
('d0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'fall', pg_temp.ago('6 days 2 hours'), pg_temp.ago('6 days 2 hours') + interval '142 seconds',
 'recovered', 'high', 0.97, '2nd floor hallway', 'demo-facility/sample-2.jpg'),
('d0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'Ground floor living area', 'fall', pg_temp.ago('5 days 8 hours'), NULL,
 'false_positive', 'medium', 0.58, 'Ground floor living room', 'demo-facility/sample-3.jpg'),
('d0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 'Ground floor living area', 'fall', pg_temp.ago('4 days 5 hours'), pg_temp.ago('4 days 5 hours') + interval '35 seconds',
 'recovered', 'medium', 0.94, 'Ground floor bathroom corridor', 'demo-facility/sample-4.jpg'),
('d0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'fall', pg_temp.ago('3 days 11 hours'), NULL,
 'unresolved', 'medium', 0.89, '2nd floor hallway', 'demo-facility/sample-5.jpg'),
('d0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'Ground floor living area', 'fall', pg_temp.ago('2 days 7 hours'), pg_temp.ago('2 days 7 hours') + interval '20 seconds',
 'recovered', 'medium', 0.92, 'Ground floor living room', 'demo-facility/sample-6.jpg'),
('d0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 'Ground floor living area', 'fall', pg_temp.ago('1 day 16 hours'), pg_temp.ago('1 day 16 hours') + interval '95 seconds',
 'recovered', 'high', 0.96, 'Ground floor bathroom corridor', 'demo-facility/sample-7.jpg'),
('d0000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'fall', pg_temp.ago('1 day 3 hours'), NULL,
 'false_positive', 'medium', 0.61, '2nd floor hallway', 'demo-facility/sample-8.jpg'),
('d0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'Ground floor living area', 'fall', pg_temp.ago('6 hours'), pg_temp.ago('6 hours') + interval '6 seconds',
 'recovered', 'medium', 0.88, 'Ground floor living room', 'demo-facility/sample-9.jpg'),
('d0000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'fall', pg_temp.ago('2 hours'), pg_temp.ago('2 hours') + interval '25 seconds',
 'recovered', 'medium', 0.93, '2nd floor hallway', 'demo-facility/sample-10.jpg');

-- Cameras that saw each incident; incident 4 was seen by both cameras of the zone.
INSERT INTO incident_cameras (tenant_id, incident_id, camera_id, track_id, joined_at, snapshot_key)
SELECT i.tenant_id, i.id, i.camera_id, 1, i.started_at, i.snapshot_key FROM incidents i
WHERE i.id::text LIKE 'd0000000-%';
INSERT INTO incident_cameras (tenant_id, incident_id, camera_id, track_id, joined_at, snapshot_key) VALUES
('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002',
 3, pg_temp.ago('4 days 5 hours') + interval '2 seconds', 'demo-facility/sample-4b.jpg');

-- ---------- ML model predictions (label timeline per incident) ----------
-- Every 5 s from the fall until recovery (or 30 s): falling, then lying, then upright.

INSERT INTO model_predictions (tenant_id, camera_id, incident_id, predicted_at, model_name, model_version,
                               label, confidence, output, inference_ms)
SELECT i.tenant_id, i.camera_id, i.id, t.at, 'yolo26n-pose.pt+rules', 'rules-v1',
       CASE WHEN t.n = 0 THEN 'falling'
            WHEN i.recovered_at IS NOT NULL AND t.at >= i.recovered_at THEN 'upright'
            ELSE 'lying' END,
       round((0.85 + random() * 0.12)::numeric, 2),
       jsonb_build_object('torso_angle_deg', CASE WHEN t.n = 0 THEN 70 ELSE 85 END),
       35 + (random() * 10)::int
FROM incidents i
CROSS JOIN LATERAL (
    SELECT n, i.started_at + n * interval '5 seconds' AS at
    FROM generate_series(0, GREATEST(1, LEAST(12, (coalesce(i.duration_seconds, 30) / 5) + 1))) AS n
) t
WHERE i.id::text LIKE 'd0000000-%' AND i.status <> 'false_positive';

INSERT INTO model_predictions (tenant_id, camera_id, incident_id, predicted_at, model_name, model_version,
                               label, confidence, output, inference_ms)
SELECT tenant_id, camera_id, id, started_at, 'yolo26n-pose.pt+rules', 'rules-v1', 'falling', peak_confidence,
       '{"torso_angle_deg": 55}', 40
FROM incidents WHERE id::text LIKE 'd0000000-%' AND status = 'false_positive';

-- ---------- Alerts ----------

INSERT INTO alerts (id, tenant_id, rule_id, camera_id, incident_id, triggered_at, severity, status, summary,
                    snapshot_key, acknowledged_at)
SELECT ('a' || substr(i.id::text, 2))::uuid, i.tenant_id, '55555555-5555-5555-5555-555555555555', i.camera_id, i.id,
       i.started_at + interval '3 seconds', i.severity,
       CASE i.id::text
           WHEN 'd0000000-0000-0000-0000-000000000003' THEN 'false_positive'
           WHEN 'd0000000-0000-0000-0000-000000000008' THEN 'false_positive'
           WHEN 'd0000000-0000-0000-0000-000000000005' THEN 'acknowledged'
           WHEN 'd0000000-0000-0000-0000-000000000007' THEN 'acknowledged'
           WHEN 'd0000000-0000-0000-0000-000000000009' THEN 'open'
           WHEN 'd0000000-0000-0000-0000-000000000010' THEN 'open'
           ELSE 'resolved' END,
       'Fall detected in ' || i.location_label || '.' || CASE
           WHEN i.status = 'recovered' THEN ' Person recovered after ' || i.duration_seconds || ' seconds.'
           WHEN i.status = 'unresolved' THEN ' Person went out of view while still down; check on them.'
           ELSE '' END,
       i.snapshot_key,
       CASE WHEN i.id::text IN ('d0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000010')
            THEN NULL ELSE i.started_at + interval '40 seconds' END
FROM incidents i WHERE i.id::text LIKE 'd0000000-%';

INSERT INTO alert_deliveries (tenant_id, alert_id, channel_id, status, attempts, error, sent_at) VALUES
('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002',
 '66666666-6666-6666-6666-666666666601', 'sent', 1, NULL, pg_temp.ago('6 days 2 hours') + interval '4 seconds'),
('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000007',
 '66666666-6666-6666-6666-666666666601', 'sent', 1, NULL, pg_temp.ago('1 day 16 hours') + interval '4 seconds'),
('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000007',
 '66666666-6666-6666-6666-666666666602', 'failed', 3, 'webhook timeout', pg_temp.ago('1 day 16 hours') + interval '10 seconds');

-- ---------- Who handled what (activity log, notes) ----------
-- The app shows acknowledged / resolved / false alarm "by" whoever is in audit_logs.

INSERT INTO audit_logs (tenant_id, action, target_type, target_id, details, created_at)
SELECT a.tenant_id, 'alert.acknowledged', 'alert', a.id,
       jsonb_build_object('actor', 'Demo Operator', 'message', 'Alert acknowledged', 'from', 'open', 'to', 'acknowledged',
                          'incident_id', a.incident_id, 'camera_id', a.camera_id),
       a.acknowledged_at
FROM alerts a WHERE a.acknowledged_at IS NOT NULL AND a.id::text LIKE 'a0000000-%';

INSERT INTO audit_logs (tenant_id, action, target_type, target_id, details, created_at)
SELECT a.tenant_id, 'alert.' || a.status, 'alert', a.id,
       jsonb_build_object('actor', CASE WHEN a.status = 'false_positive' THEN 'Demo Admin' ELSE 'Demo Operator' END,
                          'message', CASE WHEN a.status = 'false_positive' THEN 'Marked as a false alarm' ELSE 'Alert resolved' END,
                          'from', 'acknowledged', 'to', a.status, 'incident_id', a.incident_id, 'camera_id', a.camera_id,
                          'incident_from', CASE WHEN a.status = 'false_positive' THEN 'unresolved' END),
       a.triggered_at + interval '5 minutes'
FROM alerts a WHERE a.status IN ('resolved', 'false_positive') AND a.id::text LIKE 'a0000000-%';

INSERT INTO audit_logs (tenant_id, action, target_type, target_id, details, created_at) VALUES
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000001',
 '{"actor": "Demo Operator", "message": "Note added", "text": "Got up on their own; checked on them, no injury."}',
 pg_temp.ago('6 days 14 hours') + interval '3 minutes'),
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000002',
 '{"actor": "Demo Operator", "message": "Note added", "text": "Staff arrived after about 2 minutes and helped the person up."}',
 pg_temp.ago('6 days 2 hours') + interval '4 minutes'),
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000002',
 '{"actor": "Demo Admin", "message": "Note added", "text": "Family informed. Follow-up with the physiotherapist booked."}',
 pg_temp.ago('6 days 1 hour')),
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000003',
 '{"actor": "Demo Admin", "message": "Note added", "text": "Person was bending down to pick something up."}',
 pg_temp.ago('5 days 8 hours') + interval '6 minutes'),
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000005',
 '{"actor": "Demo Operator", "message": "Note added", "text": "Went out of view near the stairs; found them sitting on the bench, fine."}',
 pg_temp.ago('3 days 11 hours') + interval '5 minutes'),
('11111111-1111-1111-1111-111111111111', 'incident.note', 'incident', 'd0000000-0000-0000-0000-000000000008',
 '{"actor": "Demo Admin", "message": "Note added", "text": "A coat left on a chair was taken for a person."}',
 pg_temp.ago('1 day 3 hours') + interval '7 minutes');

UPDATE audit_logs SET details = details || jsonb_build_object('incident_id', target_id::text)
WHERE action = 'incident.note' AND tenant_id = '11111111-1111-1111-1111-111111111111';

-- Camera history for the Camera Logs page
INSERT INTO system_logs (tenant_id, camera_id, module, level, message, context, created_at) VALUES
('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003', 'camera', 'warning',
 'Not working: no video for 20 seconds', '{"event": "not_working", "camera_name": "CAM-03 Bathroom Corridor"}', pg_temp.ago('3 days 2 hours')),
('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003', 'camera', 'info',
 'Video is back', '{"event": "online", "camera_name": "CAM-03 Bathroom Corridor"}', pg_temp.ago('3 days 1 hour 40 minutes'));

-- ---------- Reports ----------

INSERT INTO reports (id, tenant_id, incident_id, status, title, summary, content, generated_at, reviewed_by, reviewed_at)
VALUES
('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002',
 'reviewed', 'Fall incident, 2nd floor hallway',
 'Person stayed on the floor for 142 seconds until staff arrived.',
 '{"camera": "CAM-01 Hallway", "duration_seconds": 142, "peak_confidence": 0.97}',
 pg_temp.ago('6 days 1 hour'), '22222222-2222-2222-2222-222222222221', pg_temp.ago('5 days 20 hours')),
('77777777-7777-7777-7777-777777777702', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001',
 'draft', 'Fall incident, living room',
 'Person recovered on their own after 8 seconds.',
 '{"camera": "CAM-02 Living Room", "duration_seconds": 8, "peak_confidence": 0.91}',
 pg_temp.ago('6 days 13 hours'), NULL, NULL);

COMMIT;
