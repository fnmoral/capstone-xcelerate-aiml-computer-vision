import json
import socket
import time
import urllib.error
import urllib.request
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from viewer import Viewer, ViewerSink


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def viewer(tmp_path):
    frame = np.full((90, 160, 3), 120, dtype=np.uint8)
    cam = SimpleNamespace(latest_annotated=frame, latest_people=[{"track": 1, "label": "lying", "confidence": 0.9}],
                          latest_at=time.time())
    sink = ViewerSink(max_incidents=2)
    (tmp_path / "snapshots").mkdir()
    cv2.imwrite(str(tmp_path / "snapshots" / "abc.jpg"), frame)
    (tmp_path / "secret.txt").write_text("no")
    port = free_port()
    Viewer("127.0.0.1", port, 10, 70, lambda: {"cam 1": cam}, sink, str(tmp_path),
           lambda: {"model": "yolo26n-pose.pt"}).start()
    time.sleep(0.2)
    return f"http://127.0.0.1:{port}", sink


def get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.headers.get("Content-Type"), r.read()


def test_page_state_config_and_frame(viewer):
    base, sink = viewer
    sink.incident({"id": "i1", "status": "active", "snapshot_key": "snapshots/abc.jpg"})
    sink.incident({"id": "i1", "status": "recovered", "snapshot_key": None})

    assert get(base + "/")[0] == 200
    state = json.loads(get(base + "/api/state")[2])
    assert state["cameras"][0]["id"] == "cam 1" and state["cameras"][0]["people"][0]["label"] == "lying"
    assert state["incidents"] == [{"id": "i1", "status": "recovered", "snapshot_key": None, "snapshots": ["abc.jpg"]}]
    assert json.loads(get(base + "/api/config")[2]) == {"model": "yolo26n-pose.pt"}

    status, ctype, body = get(base + "/frame/cam%201.jpg")  # camera IDs can contain spaces
    assert status == 200 and ctype == "image/jpeg" and body[:2] == b"\xff\xd8"
    assert get(base + "/snapshots/abc.jpg")[0] == 200


def test_unknown_paths_and_traversal_are_404(viewer):
    base, _ = viewer
    for path in ("/frame/nope.jpg", "/snapshots/..%2Fsecret.txt", "/snapshots/../secret.txt", "/etc/passwd"):
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base + path)
        assert e.value.code == 404


def test_mjpeg_stream_sends_frames(viewer):
    base, _ = viewer
    with urllib.request.urlopen(base + "/stream/cam%201", timeout=5) as r:
        assert r.headers.get("Content-Type").startswith("multipart/x-mixed-replace")
        chunk = r.read(400)
    assert b"--frame" in chunk and b"image/jpeg" in chunk


def test_sink_keeps_only_recent_incidents():
    sink = ViewerSink(max_incidents=2)
    for i in range(3):
        sink.incident({"id": f"i{i}", "snapshot_key": None})
    assert [r["id"] for r in sink.recent()] == ["i2", "i1"]
