"""Integration tests against a real PostgreSQL loaded with backend-module/db/schema.sql + seed.sql.

Skipped unless ML_TEST_DATABASE_URL is set, e.g.
    ML_TEST_DATABASE_URL=postgresql://ml_service:pw@127.0.0.1:5432/fallguard
    ML_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/fallguard   (for cleanup; default: same)
    python -m pytest tests/test_postgres.py

Use a non-superuser role for ML_TEST_DATABASE_URL, so row-level security is really applied.
The pose model is replaced by a stub (no GPU needed); everything else is the real pipeline.
Rows created here are deleted afterwards.
"""

import os
import time
import uuid

import numpy as np
import pytest

URL = os.environ.get("ML_TEST_DATABASE_URL")
ADMIN_URL = os.environ.get("ML_TEST_ADMIN_URL") or URL
pytestmark = pytest.mark.skipif(not URL, reason="ML_TEST_DATABASE_URL not set")

if URL:
    import psycopg

import pipeline as pipeline_module
from config import Config
from fall.zones import IncidentAggregator
from sinks import FanoutSink, SnapshotStore
from sinks.jsonl import JsonlSink
from tests.test_pipeline_zones import StubPose

TENANT_SLUG = "demo-facility"
TENANT_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")
CAM_02 = uuid.UUID("c0000000-0000-0000-0000-000000000002")
CAM_03 = uuid.UUID("c0000000-0000-0000-0000-000000000003")
FALL_RULE = uuid.UUID("55555555-5555-5555-5555-555555555555")
SEED_INCIDENTS = [f"d0000000-0000-0000-0000-00000000000{i}" for i in range(1, 5)]


@pytest.fixture
def db():
    conn = psycopg.connect(ADMIN_URL, autocommit=True)
    yield conn
    # Remove everything this test wrote; seed rows stay.
    conn.execute("DELETE FROM alerts WHERE incident_id IS NOT NULL AND incident_id <> ALL(%s::uuid[])", (SEED_INCIDENTS,))
    conn.execute("DELETE FROM incident_cameras WHERE incident_id <> ALL(%s::uuid[])", (SEED_INCIDENTS,))
    conn.execute("DELETE FROM incidents WHERE id <> ALL(%s::uuid[])", (SEED_INCIDENTS,))
    conn.execute("DELETE FROM model_predictions WHERE model_name LIKE '%%+rules'")
    conn.close()


@pytest.fixture
def clock(monkeypatch):
    now = [time.time()]
    monkeypatch.setattr(pipeline_module.time, "time", lambda: now[0])
    return now


def make_sink(tmp_path):
    from sinks.postgres import PostgresSink

    pg = PostgresSink(URL)
    return pg, FanoutSink([JsonlSink(str(tmp_path)), pg])


def run_fall(tmp_path, clock, cams, tenant, zones, sink):
    cfg = Config(zones=zones)
    agg = IncidentAggregator(zones, cfg.merge_window_s)
    pose = StubPose()
    pipes = []
    for cam in cams:
        p = pipeline_module.CameraPipeline(tenant, cam, cfg, sink, agg, SnapshotStore(str(tmp_path)))
        p.pose = pose
        pipes.append(p)
    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    def tick(seconds):
        for _ in range(int(seconds * 10)):
            clock[0] += 0.1
            for p in pipes:
                p.submit(frame)
                p.step()

    tick(5)
    pose.lying = False
    tick(5)


def test_zone_fall_from_database_zones(tmp_path, clock, db):
    pg, sink = make_sink(tmp_path)
    zones = pg.load_zones()
    assert "Ground floor living area" in zones
    assert str(CAM_02) in zones["Ground floor living area"] and "CAM-02 Living Room" in zones["Ground floor living area"]

    # Dev sources named after seeded cameras: names map to their UUIDs, the slug to the tenant.
    run_fall(tmp_path, clock, ["CAM-02 Living Room", "CAM-03 Bathroom Corridor"], TENANT_SLUG, zones, sink)
    assert pg.flush(10)
    sink.close()

    rows = db.execute(
        "SELECT id, tenant_id, camera_id, zone, status, severity, location_label, snapshot_key, duration_seconds "
        "FROM incidents WHERE id <> ALL(%s::uuid[])", (SEED_INCIDENTS,)).fetchall()
    assert len(rows) == 1, "one fall seen by two zoned cameras must be one incident"
    inc_id, tenant, camera, zone, status, severity, location, snapshot, duration = rows[0]
    assert (tenant, camera, zone) == (TENANT_ID, CAM_02, "Ground floor living area")
    assert (status, severity, location) == ("recovered", "medium", "Ground floor living room")
    assert snapshot and snapshot.startswith("snapshots/") and duration is not None and duration >= 3

    cams = db.execute("SELECT camera_id, track_id, snapshot_key FROM incident_cameras WHERE incident_id = %s "
                      "ORDER BY camera_id", (inc_id,)).fetchall()
    assert [c[0] for c in cams] == [CAM_02, CAM_03] and all(c[2] for c in cams)

    alerts = db.execute("SELECT rule_id, camera_id, severity, status, summary FROM alerts WHERE incident_id = %s",
                        (inc_id,)).fetchall()
    assert len(alerts) == 1
    rule, cam, sev, status, text = alerts[0]
    assert (rule, cam, sev, status) == (FALL_RULE, CAM_02, "medium", "open")
    assert "Seen by 2 cameras" in text and "recovered after" in text

    preds = db.execute("SELECT label, incident_id FROM model_predictions WHERE model_name = 'yolo26n-pose.pt+rules'"
                       ).fetchall()
    assert {p[0] for p in preds} == {"lying", "upright"}
    assert any(p[1] == inc_id for p in preds), "predictions during the fall link to the incident"


def test_unzoned_unknown_camera_gets_stable_id(tmp_path, clock, db):
    from sinks.postgres import derived_camera_id

    pg, sink = make_sink(tmp_path)
    run_fall(tmp_path, clock, ["local-webcam"], str(TENANT_ID), {}, sink)
    assert pg.flush(10)
    sink.close()
    camera = db.execute("SELECT camera_id, zone, location_label FROM incidents WHERE id <> ALL(%s::uuid[])",
                        (SEED_INCIDENTS,)).fetchone()
    assert camera == (derived_camera_id(TENANT_ID, "local-webcam"), None, None)


def test_unknown_tenant_is_skipped_not_fatal(tmp_path, clock, db):
    pg, sink = make_sink(tmp_path)
    run_fall(tmp_path, clock, ["cam-x"], "no-such-tenant", {}, sink)
    assert pg.flush(10)
    sink.close()
    assert db.execute("SELECT count(*) FROM incidents WHERE id <> ALL(%s::uuid[])", (SEED_INCIDENTS,)).fetchone()[0] == 0
    # The local JSONL file still has everything.
    assert (tmp_path / "incidents.jsonl").read_text(encoding="utf-8").count("incident_started") == 1


def test_partitions_exist_for_this_and_next_month(db):
    from sinks.postgres import PostgresSink

    PostgresSink(URL).close()  # connecting runs create_monthly_partitions
    names = {r[0] for r in db.execute(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid "
        "WHERE i.inhparent = 'incidents'::regclass")}
    this_month = time.strftime("incidents_%Y_%m")
    assert this_month in names and "incidents_default" in names


def test_database_down_does_not_block(tmp_path, clock):
    from sinks.postgres import PostgresSink

    pg = PostgresSink("postgresql://nobody@127.0.0.1:1/none", connect_timeout_s=1)
    start = time.perf_counter()
    for _ in range(100):
        pg.prediction({"tenant_id": "x"})
    assert time.perf_counter() - start < 0.5, "queuing must never wait for the database"
    pg._stop.set()
