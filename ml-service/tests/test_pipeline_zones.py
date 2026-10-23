"""Two cameras in one zone see the same person fall: one incident, not two.

Runs the real CameraPipeline, monitor, aggregator and sink, with the pose model replaced by
a stub and a fake clock, so no GPU or video is needed.
"""

import json

import numpy as np
import pytest

import pipeline as pipeline_module
from config import Config
from fall.zones import IncidentAggregator
from sinks.jsonl import JsonlSink
from vision.pose import Person

LYING = np.zeros((17, 3), dtype=np.float32)
LYING[0] = (300, 400, 0.9)                       # nose
LYING[5], LYING[6] = (270, 395, 0.9), (270, 405, 0.9)    # shoulders
LYING[11], LYING[12] = (170, 395, 0.9), (170, 405, 0.9)  # hips
STANDING = np.zeros((17, 3), dtype=np.float32)
STANDING[0] = (100, 50, 0.9)
STANDING[5], STANDING[6] = (90, 80, 0.9), (110, 80, 0.9)
STANDING[11], STANDING[12] = (92, 180, 0.9), (108, 180, 0.9)


class StubPose:
    def __init__(self):
        self.lying = True

    def __call__(self, frame):
        if self.lying:
            return [Person(1, np.array([150, 380, 320, 420], dtype=np.float32), 0.9, LYING)]
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
        p = pipeline_module.CameraPipeline("t", cam_id, cfg, sink, agg)
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
    p = pipeline_module.CameraPipeline("t", "cam-1", cfg, sink, IncidentAggregator({}, 10))
    p.pose = StubPose()
    for _ in range(50):
        clock[0] += 0.1
        p.submit(np.zeros((480, 640, 3), dtype=np.uint8))
        p.step()
    p.close()
    events = [json.loads(x) for x in (tmp_path / "incidents.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [e["event"] for e in events] == ["incident_started", "incident_unresolved"]
    assert events[-1]["status"] == "unresolved"
