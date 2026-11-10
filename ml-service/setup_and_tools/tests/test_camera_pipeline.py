"""Tests for app/camera_service/camera_pipeline.py: the camera pipeline and zones.
"""

import json

import numpy as np
import pytest

import app.camera_service.camera_pipeline as pipeline_module
from app import config
from app.camera_service.camera_pipeline import IncidentAggregator
from app.camera_service.results import JsonlSink, SnapshotStore
from app.config import Config
from app.detection.fall_detection import Incident, IncidentEvent, RECOVERED, STARTED, UNRESOLVED, UPDATED
from app.detection.pose_model import Person


# ================================================================================================
# 1. Two cameras of one zone, through the real pipeline
# ================================================================================================
#
# Two cameras in one zone see the same person fall: one incident, not two.
#
# Runs the real CameraPipeline, monitor, aggregator and sink, with the pose model replaced by
# a stub and a fake clock, so no GPU or video is needed.

LYING = np.zeros((17, 3), dtype=np.float32)
LYING[0] = (300, 400, 0.9)                       # nose
LYING[5], LYING[6] = (270, 395, 0.9), (270, 405, 0.9)    # shoulders
LYING[11], LYING[12] = (170, 395, 0.9), (170, 405, 0.9)  # hips
LYING[13], LYING[14] = (110, 395, 0.9), (110, 405, 0.9)  # knees
LYING[15], LYING[16] = (55, 395, 0.9), (55, 405, 0.9)    # ankles
STANDING = np.zeros((17, 3), dtype=np.float32)
STANDING[0] = (100, 50, 0.9)
STANDING[5], STANDING[6] = (90, 80, 0.9), (110, 80, 0.9)
STANDING[11], STANDING[12] = (92, 180, 0.9), (108, 180, 0.9)
STANDING[13], STANDING[14] = (92, 240, 0.9), (108, 240, 0.9)
STANDING[15], STANDING[16] = (92, 295, 0.9), (108, 295, 0.9)


class StubPose:
    def __init__(self):
        self.lying = True

    def __call__(self, frame):
        if self.lying:
            return [Person(1, np.array([40, 380, 320, 420], dtype=np.float32), 0.9, LYING)]
        return [Person(1, np.array([80, 40, 120, 300], dtype=np.float32), 0.9, STANDING)]


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(pipeline_module.time, "time", lambda: now[0])
    return now


def run(tmp_path, clock, zones):
    cfg = Config(zones=zones)
    sink = JsonlSink(str(tmp_path))
    agg = IncidentAggregator(cfg.zones, cfg.merge_window_s)
    pose = StubPose()
    cams = []
    for cam_id in ("cam-1", "cam-2"):
        p = pipeline_module.CameraPipeline("t", cam_id, cfg, sink, agg, SnapshotStore(str(tmp_path)))
        p.pose = pose
        cams.append(p)

    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    def tick(seconds):
        for _ in range(int(seconds * 10)):
            clock[0] += 0.1
            for p in cams:
                p.submit(frame)
                p.step()

    tick(5)             # both cameras see the person lying for 5 s
    pose.lying = False
    tick(5)             # they get up
    lines = (tmp_path / "incidents.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines]


def test_zoned_cameras_raise_one_incident(tmp_path, clock):
    events = run(tmp_path, clock, {"room-1": ["cam-1", "cam-2"]})
    assert [e["event"] for e in events] == ["incident_started", "incident_updated", "incident_recovered"]
    assert len({e["id"] for e in events}) == 1
    assert events[-1]["camera_ids"] == ["cam-1", "cam-2"] and events[-1]["status"] == "recovered"
    snapshots = sorted(p.name for p in (tmp_path / "snapshots").iterdir())
    assert len(snapshots) == 2  # one photo per camera, same incident


def test_unzoned_cameras_raise_two_incidents(tmp_path, clock):
    events = run(tmp_path, clock, {})
    started = [e for e in events if e["event"] == "incident_started"]
    assert len(started) == 2 and {e["camera_id"] for e in started} == {"cam-1", "cam-2"}


def test_camera_disconnect_marks_open_incident_unresolved(tmp_path, clock):
    cfg = Config()
    sink = JsonlSink(str(tmp_path))
    p = pipeline_module.CameraPipeline("t", "cam-1", cfg, sink, IncidentAggregator({}, 10), SnapshotStore(str(tmp_path)))
    p.pose = StubPose()
    for _ in range(50):
        clock[0] += 0.1
        p.submit(np.zeros((480, 640, 3), dtype=np.uint8))
        p.step()
    p.close()
    events = [json.loads(x) for x in (tmp_path / "incidents.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [e["event"] for e in events] == ["incident_started", "incident_unresolved"]
    assert events[-1]["status"] == "unresolved"


# ================================================================================================
# 2. The zone aggregator on its own
# ================================================================================================

ZONES = {"ward-a": ["cam-1", "cam-2"]}


def event(kind, inc, t=0.0):
    return IncidentEvent(kind, inc, t)


def test_overlapping_cameras_give_one_alert():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(track_id=1, started_at=100.0, peak_confidence=0.8)
    b = Incident(track_id=7, started_at=102.0, peak_confidence=0.9)

    [(kind1, group)] = agg.handle("t", "cam-1", event(STARTED, a))
    [(kind2, same)] = agg.handle("t", "cam-2", event(STARTED, b))
    assert (kind1, kind2) == (STARTED, UPDATED)  # second camera joins, no second alert
    assert same is group
    assert group.cameras == ["cam-1", "cam-2"]
    assert group.tracks == ["cam-1#1", "cam-2#7"]
    assert group.started_at == 100.0 and group.peak_confidence == 0.9


def test_merged_incident_closes_when_every_camera_closes():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(1, 100.0, 0.8)
    b = Incident(2, 101.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    agg.handle("t", "cam-2", event(STARTED, b))

    a.recovered_at = 130.0
    assert agg.handle("t", "cam-1", event(RECOVERED, a)) == []  # cam-2 still sees them down
    [(kind, group)] = agg.handle("t", "cam-2", event(UNRESOLVED, b))  # cam-2 lost sight of them
    assert kind == RECOVERED and group.status == "recovered" and group.recovered_at == 130.0


def test_all_cameras_unresolved_means_unresolved():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(1, 100.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    [(kind, group)] = agg.handle("t", "cam-1", event(UNRESOLVED, a))
    assert kind == UNRESOLVED and group.status == "unresolved"


def test_severity_is_highest_of_any_camera():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a, b = Incident(1, 100.0, 0.8), Incident(2, 101.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    agg.handle("t", "cam-2", event(STARTED, b))
    b.severity = "high"
    [(kind, group)] = agg.handle("t", "cam-2", event(UPDATED, b))
    assert kind == UPDATED and group.severity == "high"
    a.severity = "high"
    assert agg.handle("t", "cam-1", event(UPDATED, a)) == []  # nothing new to report


@pytest.mark.parametrize("cam2, start2, tenant2", [
    ("cam-3", 101.0, "t"),   # different zone (cam-3 isn't zoned)
    ("cam-2", 120.0, "t"),   # same zone but outside the merge window
    ("cam-2", 101.0, "t2"),  # same zone, other tenant
])
def test_not_merged(cam2, start2, tenant2):
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
    [(kind, group)] = agg.handle(tenant2, cam2, event(STARTED, Incident(2, start2, 0.8)))
    assert kind == STARTED and group.cameras == [cam2]


def test_two_people_on_one_camera_stay_separate():
    for zones in ({}, ZONES):  # unzoned and zoned camera alike
        agg = IncidentAggregator(zones, merge_window_s=10)
        [(k1, g1)] = agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
        [(k2, g2)] = agg.handle("t", "cam-1", event(STARTED, Incident(2, 101.0, 0.8)))
        assert (k1, k2) == (STARTED, STARTED) and g1 is not g2


def test_second_camera_joins_the_closest_incident():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    [(_, early)] = agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
    [(_, late)] = agg.handle("t", "cam-1", event(STARTED, Incident(2, 106.0, 0.8)))
    [(kind, joined)] = agg.handle("t", "cam-2", event(STARTED, Incident(5, 105.0, 0.8)))
    assert kind == UPDATED and joined is late and late.cameras == ["cam-1", "cam-2"]
    assert early.cameras == ["cam-1"]


def test_zone_config_validation(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text("zones:\n  a: [cam-1, cam-2]\n  b: [cam-2]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="in two zones"):
        config.load(p, prod_mode=False)

    p.write_text("zones:\n  a: cam-1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="list of camera_ids"):
        config.load(p, prod_mode=False)

    p.write_text("zones:\n  a: [cam-1]\nfall:\n  merge_window_seconds: 5\n", encoding="utf-8")
    cfg = config.load(p, prod_mode=False)
    assert cfg.zones == {"a": ["cam-1"]} and cfg.merge_window_s == 5
