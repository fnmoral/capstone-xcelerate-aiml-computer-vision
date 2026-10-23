-- Dev seed data for fall detection. Run AFTER schema.sql. Do not use in production.
-- Fixed UUIDs so the front end, tests and ML code can refer to the same rows.
-- Timestamps are in America/Toronto (EDT, -04:00) and fall inside the 2026-10 partitions.

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

INSERT INTO sites (id, tenant_id, name, timezone)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        'Main Building', 'America/Toronto');

INSERT INTO gateways (id, tenant_id, site_id, name, auth_token_hash, last_seen_at)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'gateway-main-01', 'dev-only-token-hash',
        '2026-10-13 06:05:00-04');

-- Cameras 02 and 03 both cover the ground floor living area, so a fall seen by both is one incident.
INSERT INTO zones (id, tenant_id, site_id, name)
VALUES ('99999999-9999-9999-9999-999999999901', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'Ground floor living area');

INSERT INTO cameras (id, tenant_id, site_id, gateway_id, name, rtsp_url_enc, status,
                     keyframe_interval_s, resolution, location) VALUES
('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
 'CAM-01 Hallway', 'placeholder'::bytea, 'online', 2, '1920x1080', '2nd floor hallway'),
('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
 'CAM-02 Living Room', 'placeholder'::bytea, 'online', 2, '1920x1080', 'Ground floor living room'),
('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
 '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
 'CAM-03 Bathroom Corridor', 'placeholder'::bytea, 'online', 2, '1280x720', 'Ground floor bathroom corridor');

UPDATE cameras SET zone_id = '99999999-9999-9999-9999-999999999901'
WHERE id IN ('c0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000003');

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

-- ---------- Frames (one key frame per incident) ----------

INSERT INTO frames (id, tenant_id, camera_id, captured_at, object_key, width, height) VALUES
('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 '2026-10-12 09:14:05-04', 'demo-facility/cam-02/2026/10/12/091405.jpg', 1920, 1080),
('f0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 '2026-10-12 21:47:30-04', 'demo-facility/cam-01/2026/10/12/214730.jpg', 1920, 1080),
('f0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 '2026-10-13 06:02:11-04', 'demo-facility/cam-03/2026/10/13/060211.jpg', 1280, 720),
('f0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 '2026-10-11 15:30:00-04', 'demo-facility/cam-02/2026/10/11/153000.jpg', 1920, 1080);

-- ---------- Detection events ----------

INSERT INTO events (id, tenant_id, camera_id, frame_id, occurred_at, event_type, confidence,
                    caption, detections, model_version) VALUES
('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'f0000000-0000-0000-0000-000000000001', '2026-10-12 09:14:05-04', 'fall', 0.91,
 'Person falls near the sofa',
 '[{"label":"person","bbox":[612,340,280,410],"confidence":0.91}]', 'fall-detector-dev'),
('e0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 'f0000000-0000-0000-0000-000000000002', '2026-10-12 21:47:30-04', 'fall', 0.97,
 'Person falls in the middle of the hallway',
 '[{"label":"person","bbox":[880,520,330,260],"confidence":0.97}]', 'fall-detector-dev'),
('e0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 'f0000000-0000-0000-0000-000000000003', '2026-10-13 06:02:11-04', 'fall', 0.95,
 'Person falls near the bathroom door',
 '[{"label":"person","bbox":[400,300,250,220],"confidence":0.95}]', 'fall-detector-dev'),
('e0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'f0000000-0000-0000-0000-000000000004', '2026-10-11 15:30:00-04', 'fall', 0.58,
 'Person bends down to pick something up',
 '[{"label":"person","bbox":[700,400,260,300],"confidence":0.58}]', 'fall-detector-dev');

-- ---------- Incidents ----------
-- 1: quick self recovery (8s)   2: long time on floor (142s)
-- 3: still on the floor now (no recovery yet)   4: false positive

INSERT INTO incidents (id, tenant_id, camera_id, incident_type, started_at, recovered_at,
                       status, severity, peak_confidence, location_label, snapshot_key, notes) VALUES
('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'fall', '2026-10-12 09:14:05-04', '2026-10-12 09:14:13-04',
 'recovered', 'low', 0.91, 'Ground floor living room',
 'demo-facility/cam-02/2026/10/12/091405.jpg', 'Got up on their own'),
('d0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 'fall', '2026-10-12 21:47:30-04', '2026-10-12 21:49:52-04',
 'recovered', 'high', 0.97, '2nd floor hallway',
 'demo-facility/cam-01/2026/10/12/214730.jpg', 'Staff arrived and helped the person up'),
('d0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 'fall', '2026-10-13 06:02:11-04', NULL,
 'active', 'critical', 0.95, 'Ground floor bathroom corridor',
 'demo-facility/cam-03/2026/10/13/060211.jpg', NULL),
('d0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'fall', '2026-10-11 15:30:00-04', NULL,
 'false_positive', 'low', 0.58, 'Ground floor living room',
 'demo-facility/cam-02/2026/10/11/153000.jpg', 'Person was bending to pick up an item');

-- Cameras that saw each incident (one each here; a zone incident would list several)
INSERT INTO incident_cameras (tenant_id, incident_id, camera_id, track_id, joined_at, snapshot_key) VALUES
('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002',
 1, '2026-10-12 09:14:05-04', 'demo-facility/cam-02/2026/10/12/091405.jpg'),
('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
 1, '2026-10-12 21:47:30-04', 'demo-facility/cam-01/2026/10/12/214730.jpg'),
('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
 1, '2026-10-13 06:02:11-04', 'demo-facility/cam-03/2026/10/13/060211.jpg'),
('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002',
 1, '2026-10-11 15:30:00-04', 'demo-facility/cam-02/2026/10/11/153000.jpg');

UPDATE incidents SET zone = 'Ground floor living area'
WHERE id IN ('d0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003',
             'd0000000-0000-0000-0000-000000000004');

-- ---------- ML model predictions (sequence per incident) ----------

INSERT INTO model_predictions (id, tenant_id, camera_id, frame_id, incident_id, predicted_at,
                               model_name, model_version, label, confidence, output, inference_ms) VALUES
-- incident 1
('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', '2026-10-12 09:14:05-04',
 'fall-detector', 'dev', 'falling', 0.91, '{"torso_angle_deg":78}', 42),
('b0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 NULL, 'd0000000-0000-0000-0000-000000000001', '2026-10-12 09:14:09-04',
 'fall-detector', 'dev', 'lying',    0.84, '{"torso_angle_deg":85}', 40),
('b0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 NULL, 'd0000000-0000-0000-0000-000000000001', '2026-10-12 09:14:13-04',
 'fall-detector', 'dev', 'upright',  0.93, '{"torso_angle_deg":8}', 41),
-- incident 2
('b0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 'f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', '2026-10-12 21:47:30-04',
 'fall-detector', 'dev', 'falling', 0.97, '{"torso_angle_deg":81}', 44),
('b0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'd0000000-0000-0000-0000-000000000002', '2026-10-12 21:47:45-04',
 'fall-detector', 'dev', 'lying',    0.95, '{"torso_angle_deg":87}', 43),
('b0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'd0000000-0000-0000-0000-000000000002', '2026-10-12 21:48:45-04',
 'fall-detector', 'dev', 'lying',    0.96, '{"torso_angle_deg":88}', 42),
('b0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
 NULL, 'd0000000-0000-0000-0000-000000000002', '2026-10-12 21:49:52-04',
 'fall-detector', 'dev', 'upright',  0.90, '{"torso_angle_deg":10}', 41),
-- incident 3 (still active)
('b0000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 'f0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', '2026-10-13 06:02:11-04',
 'fall-detector', 'dev', 'falling', 0.95, '{"torso_angle_deg":80}', 39),
('b0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 NULL, 'd0000000-0000-0000-0000-000000000003', '2026-10-13 06:02:41-04',
 'fall-detector', 'dev', 'lying',    0.96, '{"torso_angle_deg":86}', 40),
('b0000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003',
 NULL, 'd0000000-0000-0000-0000-000000000003', '2026-10-13 06:03:41-04',
 'fall-detector', 'dev', 'lying',    0.97, '{"torso_angle_deg":88}', 40),
-- incident 4 (false positive, low confidence)
('b0000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
 'f0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004', '2026-10-11 15:30:00-04',
 'fall-detector', 'dev', 'falling', 0.58, '{"torso_angle_deg":55}', 43);

-- ---------- Alerts and delivery attempts ----------

INSERT INTO alerts (id, tenant_id, rule_id, camera_id, event_id, incident_id, triggered_at,
                    severity, status, summary, snapshot_key, acknowledged_by, acknowledged_at) VALUES
('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
 'c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
 '2026-10-12 09:14:05-04', 'low', 'resolved',
 'Fall detected in Ground floor living room. Person recovered after 8 seconds.',
 'demo-facility/cam-02/2026/10/12/091405.jpg',
 '22222222-2222-2222-2222-222222222222', '2026-10-12 09:15:00-04'),
('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
 'c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
 '2026-10-12 21:47:30-04', 'high', 'resolved',
 'Fall detected in 2nd floor hallway. Person on the floor for 142 seconds.',
 'demo-facility/cam-01/2026/10/12/214730.jpg',
 '22222222-2222-2222-2222-222222222222', '2026-10-12 21:48:20-04'),
('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
 'c0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003',
 '2026-10-13 06:02:11-04', 'critical', 'open',
 'Fall detected in Ground floor bathroom corridor. Person has not recovered.',
 'demo-facility/cam-03/2026/10/13/060211.jpg', NULL, NULL),
('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
 'c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004',
 '2026-10-11 15:30:00-04', 'low', 'false_positive',
 'Possible fall in Ground floor living room. Marked as false positive.',
 'demo-facility/cam-02/2026/10/11/153000.jpg',
 '22222222-2222-2222-2222-222222222222', '2026-10-11 15:31:00-04');

INSERT INTO alert_deliveries (id, tenant_id, alert_id, channel_id, status, attempts, error, sent_at) VALUES
('88888888-8888-8888-8888-888888888801', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002',
 '66666666-6666-6666-6666-666666666601', 'sent',   1, NULL, '2026-10-12 21:47:33-04'),
('88888888-8888-8888-8888-888888888802', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003',
 '66666666-6666-6666-6666-666666666601', 'sent',   1, NULL, '2026-10-13 06:02:14-04'),
('88888888-8888-8888-8888-888888888803', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003',
 '66666666-6666-6666-6666-666666666602', 'failed', 3, 'webhook timeout', '2026-10-13 06:02:20-04');

-- ---------- Reports ----------

INSERT INTO reports (id, tenant_id, incident_id, status, title, summary, content, file_key,
                     generated_at, reviewed_by, reviewed_at) VALUES
('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002',
 'reviewed', 'Fall incident, 2nd floor hallway, 2026-10-12',
 'Fall detected at 21:47:30. Person stayed on the floor for 142 seconds until staff arrived.',
 '{"camera":"CAM-01 Hallway","started_at":"2026-10-12T21:47:30-04:00","recovered_at":"2026-10-12T21:49:52-04:00","duration_seconds":142,"peak_confidence":0.97}',
 'demo-facility/reports/incident-d0000000-0000-0000-0000-000000000002.pdf',
 '2026-10-12 22:10:00-04', '22222222-2222-2222-2222-222222222221', '2026-10-13 08:00:00-04'),
('77777777-7777-7777-7777-777777777702', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001',
 'draft', 'Fall incident, living room, 2026-10-12',
 'Fall detected at 09:14:05. Person recovered on their own after 8 seconds.',
 '{"camera":"CAM-02 Living Room","duration_seconds":8,"peak_confidence":0.91}',
 NULL, '2026-10-12 09:30:00-04', NULL, NULL);
