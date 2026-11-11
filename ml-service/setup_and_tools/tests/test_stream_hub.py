"""Tests for the stream-hub side of ml-service: the wire protocol with PTS, the decoder,
the frame buffer, the result messages sent back, the reporter, the TCP server, and the
pipeline wired to all of them.

No GPU, model or real stream-hub is needed: the pose model is a stub and the "hub" is a
socket pair or a local client.
"""

import base64
import io
import json
import socket
import threading
import time

import av
import numpy as np
import pytest

import app.camera_service.camera_pipeline as pipeline_module
from app.camera_service import hub_results
from app.camera_service.camera_pipeline import IncidentAggregator
from app.camera_service.frame_buffer import FrameBuffer
from app.camera_service.hub_server import StreamHubServer
from app.camera_service.incident_reporter import IncidentReporter
from app.camera_service.results import FanoutSink, SnapshotStore, clip_key, snapshot_key
from app.camera_service.video_input import (FrameSampler, MAX_NALU_LEN, ProtocolError, VideoDecoder, read_frame,
                                            read_handshake, read_message, write_frame, write_message)
from app.config import Config
from app.detection.fall_detection import Incident, IncidentEvent, RECOVERED, STARTED
from app.detection.pose_model import Person


# ================================================================================================
# 1. Wire protocol: NALUs carry a PTS, results go back as JSON
# ================================================================================================

def test_frame_roundtrip_keeps_pts_and_bytes():
    a, b = socket.socketpair()
    with a, b:
        write_frame(a, 1_730_990_000_123, b"\x00\x00\x00\x01\x67abc")
        write_frame(a, 1_730_990_000_156, b"\x41xyz")
        assert read_frame(b, MAX_NALU_LEN) == (1_730_990_000_123, b"\x00\x00\x00\x01\x67abc")
        assert read_frame(b, MAX_NALU_LEN) == (1_730_990_000_156, b"\x41xyz")


def test_frame_clean_close_is_none_and_bad_length_is_an_error():
    a, b = socket.socketpair()
    with b:
        a.close()
        assert read_frame(b, MAX_NALU_LEN) is None

    a, b = socket.socketpair()
    with a, b:
        write_frame(a, 1, b"")  # an empty NALU is not valid
        with pytest.raises(ProtocolError):
            read_frame(b, MAX_NALU_LEN)

    a, b = socket.socketpair()
    with a, b:
        write_frame(a, 1, b"x" * 100)
        with pytest.raises(ProtocolError):
            read_frame(b, 10)  # longer than the limit


def test_frame_cut_off_mid_nalu_is_an_error():
    a, b = socket.socketpair()
    with b:
        a.sendall(b"\x00\x00\x00\x0a" + (123).to_bytes(8, "big") + b"abc")  # promises 10 bytes, sends 3
        a.close()
        with pytest.raises(ProtocolError):
            read_frame(b, MAX_NALU_LEN)


def test_handshake_with_and_without_tenant():
    a, b = socket.socketpair()
    with a, b:
        write_message(a, b"tenant-1")
        write_message(a, b"cam-1")
        assert read_handshake(b, True, "default") == ("tenant-1", "cam-1")
        write_message(a, b"cam-2")
        assert read_handshake(b, False, "default") == ("default", "cam-2")


# ================================================================================================
# 2. Decoder: a PTS per picture, frames come back tagged with it
# ================================================================================================

def encode_h264(n_frames: int = 12, size: tuple[int, int] = (128, 96)) -> list[bytes]:
    """Encode a few moving frames; returns one Annex-B packet per picture."""
    buf = io.BytesIO()
    container = av.open(buf, "w", format="h264")
    stream = container.add_stream("libx264", rate=10)
    stream.width, stream.height, stream.pix_fmt = size[0], size[1], "yuv420p"
    stream.options = {"preset": "ultrafast", "tune": "zerolatency", "g": "5", "bf": "0"}
    packets: list[bytes] = []
    for i in range(n_frames):
        img = np.zeros((size[1], size[0], 3), dtype=np.uint8)
        img[:, : (i + 1) * 8 % size[0] or 8] = (40 + i * 10, 120, 200)
        frame = av.VideoFrame.from_ndarray(img, format="bgr24")
        for packet in stream.encode(frame):
            packets.append(bytes(packet))
    for packet in stream.encode():
        packets.append(bytes(packet))
    container.close()
    return packets


@pytest.fixture(scope="module")
def pictures() -> list[bytes]:
    packets = encode_h264()
    assert len(packets) >= 10
    return packets


def test_decoder_with_pts_tags_frames_with_their_picture_pts(pictures):
    dec = VideoDecoder("cam")
    tagged = []
    base = 1_730_990_000_000
    for i, packet in enumerate(pictures):
        for frame in dec.decode(packet, base + i * 100):
            tagged.append(frame.pts)
    # The last picture is held back until a newer PTS arrives (one frame of latency).
    assert tagged, "no frames decoded"
    assert tagged == [base + i * 100 for i in range(len(tagged))]
    assert len(tagged) >= len(pictures) - 2
    assert dec.codec == "h264"


def test_decoder_groups_nalus_of_one_picture_by_pts(pictures):
    """Two NALUs with the same PTS are one picture: they are decoded together."""
    dec = VideoDecoder("cam")
    first = pictures[0]
    half = len(first) // 2
    assert dec.decode(first[:half], 111) == []          # still collecting this picture
    assert dec.decode(first[half:], 111) == []          # same PTS: same picture
    frames = dec.decode(pictures[1], 222)               # a new PTS closes the first picture
    assert len(frames) <= 1                             # decodes (or fails softly), never raises
    if frames:
        assert frames[0].pts == 111


def test_decoder_without_pts_still_works(pictures):
    dec = VideoDecoder("cam")
    frames = []
    for packet in pictures:
        frames.extend(dec.decode(packet))
    assert len(frames) >= len(pictures) - 2
    assert VideoDecoder.to_bgr(frames[0]).shape == (96, 128, 3)


def test_decoder_drops_nalus_until_a_parameter_set():
    dec = VideoDecoder("cam")
    assert dec.decode(b"\x00\x00\x00\x01\x41not-a-parameter-set", 5) == []
    assert dec.codec is None


# ================================================================================================
# 3. FrameBuffer: the newest frame, with its PTS, plus throughput counters
# ================================================================================================

def test_buffer_keeps_only_the_newest_frame_and_its_pts():
    buf = FrameBuffer()
    sampler = FrameSampler(0)  # no rate limit
    f1, f2 = np.zeros((4, 4, 3), np.uint8), np.ones((4, 4, 3), np.uint8)
    buf.submit(f1, 1000)
    buf.submit(f2, 2000)
    frame, pts = buf.take_due(sampler, time.time())
    assert pts == 2000 and frame is f2
    assert buf.take_due(sampler, time.time()) is None  # consumed


def test_buffer_without_pts_uses_the_wall_clock():
    buf = FrameBuffer()
    before = int(time.time() * 1000)
    buf.submit(np.zeros((2, 2, 3), np.uint8), None)
    _, pts = buf.take_due(FrameSampler(0), time.time())
    assert before <= pts <= int(time.time() * 1000) + 1


def test_buffer_sampler_can_hold_a_frame_back():
    buf = FrameBuffer()
    sampler = FrameSampler(1)  # 1 fps; the sampler allows one slot of catch-up after the first frame
    now = time.time()
    taken = []
    for i, offset in enumerate((0.0, 0.1, 0.2, 1.3)):
        buf.submit(np.zeros((2, 2, 3), np.uint8), i)
        taken.append(buf.take_due(sampler, now + offset) is not None)
    assert taken == [True, True, False, True]  # the 3rd came too soon after the 2nd


def test_buffer_counts_received_and_analysed():
    buf = FrameBuffer()
    buf.submit(np.zeros((2, 2, 3), np.uint8), 1)
    buf.count_received()
    buf.record_analysed(25.0)
    frames_in, analysed, model_ms, seconds = buf.take_stats()
    assert (frames_in, analysed, model_ms) == (2, 1, 25.0) and seconds > 0
    assert buf.take_stats()[:3] == (0, 0, 0.0)  # reset after each read


# ================================================================================================
# 4. Result messages and the writer that sends them to stream-hub
# ================================================================================================

def test_person_entry_normalises_the_box():
    p = hub_results.person_entry(3, "lying", 0.912, np.array([64.0, 48.0, 320.0, 240.0]), 640, 480, "inc-1")
    assert p == {"track": 3, "label": "lying", "confidence": 0.91, "box": [0.1, 0.1, 0.5, 0.5], "incident_id": "inc-1"}


def test_person_entry_clamps_boxes_that_leave_the_frame():
    p = hub_results.person_entry(1, "upright", 0.5, [-10, -10, 700, 500], 640, 480, None)
    assert p["box"] == [0.0, 0.0, 1.0, 1.0] and p["incident_id"] is None


def test_message_shapes():
    d = hub_results.detections_message("cam1", 123, 640, 480, [])
    assert d == {"type": "detections", "camera_id": "cam1", "pts": 123, "width": 640, "height": 480, "people": []}
    i = hub_results.incident_message("cam1", None, "incident_started", "i1", "medium", "z", ["cam1"])
    assert i["type"] == "incident" and i["pts"] is None and i["cameras"] == ["cam1"]
    assert hub_results.recording_message("cam1", "start", "i1") == {
        "type": "recording", "camera_id": "cam1", "action": "start", "incident_id": "i1"}
    s = hub_results.snapshot_message("cam1", "i1", "i1.jpg", b"\xff\xd8jpeg")
    assert base64.b64decode(s["jpeg"]) == b"\xff\xd8jpeg" and s["name"] == "i1.jpg"


def read_json(sock) -> dict:
    return json.loads(read_message(sock, 16 << 20))


def test_result_writer_sends_framed_json_and_control_goes_first():
    a, b = socket.socketpair()
    b.settimeout(5)
    with a, b:
        writer = hub_results.ResultWriter(a, "cam1")
        # Queue under the writer's lock so its thread can't send meanwhile: the order is deterministic.
        with writer._cond:
            writer._detections.append({"type": "detections", "n": 1})
            writer._control.append({"type": "recording", "n": 2})
            writer._cond.notify()
        assert read_json(b)["type"] == "recording"
        assert read_json(b)["type"] == "detections"
        writer.close()


def test_result_writer_drops_old_detections_but_never_control_messages():
    a, b = socket.socketpair()
    b.settimeout(5)
    with a, b:
        writer = hub_results.ResultWriter(a, "cam1", max_detections=2)
        # Enqueue while holding the writer's lock, so its thread can't send anything meanwhile.
        with writer._cond:
            for n in range(5):
                if len(writer._detections) == writer._detections.maxlen:
                    writer._dropped += 1
                writer._detections.append({"type": "detections", "n": n})
            writer._control.append({"type": "incident", "n": "keep"})
            writer._cond.notify()
        got = [read_json(b) for _ in range(3)]
        assert got[0] == {"type": "incident", "n": "keep"}
        assert [m["n"] for m in got[1:]] == [3, 4]  # only the newest two detections survive
        writer.close()


def test_result_writer_publish_after_close_is_ignored():
    a, b = socket.socketpair()
    with a, b:
        writer = hub_results.ResultWriter(a, "cam1")
        writer.close()
        writer.publish({"type": "recording"})  # must not raise or block
        b.settimeout(0.3)
        with pytest.raises((TimeoutError, socket.timeout)):
            b.recv(1)


# ================================================================================================
# 5. IncidentReporter: one place that turns incidents into DB records + stream-hub messages
# ================================================================================================

class Collect:
    """A sink and a publish function in one, recording everything it is given."""

    def __init__(self):
        self.incidents, self.predictions, self.clips, self.messages = [], [], [], []

    def incident(self, r): self.incidents.append(r)
    def prediction(self, r): self.predictions.append(r)
    def clip(self, r): self.clips.append(r)
    def close(self): pass
    def publish(self, m): self.messages.append(m)

    def of_type(self, kind): return [m for m in self.messages if m["type"] == kind]


FRAME = np.full((48, 64, 3), 90, dtype=np.uint8)


def make_reporter(tmp_path, publish=True):
    c = Collect()
    agg = IncidentAggregator({}, 10)
    rep = IncidentReporter("t", "cam-1", c, agg, SnapshotStore(str(tmp_path)), c.publish if publish else None)
    return rep, c


def test_started_incident_commands_recording_and_sends_a_snapshot(tmp_path):
    rep, c = make_reporter(tmp_path)
    inc = Incident(track_id=1, started_at=100.0, peak_confidence=0.9)
    rep.report(IncidentEvent(STARTED, inc, 100.0), FRAME, pts=555)

    [rec] = c.of_type("recording")
    assert rec["action"] == "start" and rec["camera_id"] == "cam-1"
    [snap] = c.of_type("snapshot")
    assert snap["incident_id"] == rec["incident_id"]
    assert base64.b64decode(snap["jpeg"])[:2] == b"\xff\xd8"          # a JPEG
    [message] = c.of_type("incident")
    assert message["event"] == "incident_started" and message["pts"] == 555
    # The database record names the files stream-hub will store.
    [record] = c.incidents
    assert record["snapshot_key"] == snapshot_key(snap["name"])
    assert not list((tmp_path / "snapshots").iterdir())               # no file written locally


def test_recovered_incident_stops_recording_and_records_the_clip_key(tmp_path):
    rep, c = make_reporter(tmp_path)
    inc = Incident(1, 100.0, 0.9)
    rep.report(IncidentEvent(STARTED, inc, 100.0), FRAME, pts=1)
    incident_id = c.of_type("recording")[0]["incident_id"]
    inc.recovered_at = 130.0
    rep.report(IncidentEvent(RECOVERED, inc, 130.0), None, pts=2)

    stops = [m for m in c.of_type("recording") if m["action"] == "stop"]
    assert [m["incident_id"] for m in stops] == [incident_id]
    [clip] = c.clips
    assert clip["clip_key"] == clip_key(incident_id, "cam-1") and clip["seconds"] is None


def test_source_without_stream_hub_publishes_nothing_and_saves_snapshots_locally(tmp_path):
    rep, c = make_reporter(tmp_path, publish=False)
    inc = Incident(1, 100.0, 0.9)
    rep.report(IncidentEvent(STARTED, inc, 100.0), FRAME)
    inc.recovered_at = 120.0
    rep.report(IncidentEvent(RECOVERED, inc, 120.0), None)
    assert c.messages == [] and c.clips == []
    assert len(list((tmp_path / "snapshots").iterdir())) == 1


def test_a_failing_publish_never_breaks_reporting(tmp_path):
    c = Collect()
    rep = IncidentReporter("t", "cam-1", c, IncidentAggregator({}, 10), SnapshotStore(str(tmp_path)),
                           lambda m: (_ for _ in ()).throw(OSError("hub gone")))
    rep.report(IncidentEvent(STARTED, Incident(1, 100.0, 0.9), 100.0), FRAME, pts=1)
    assert len(c.incidents) == 1  # still recorded for the database


def test_detections_are_sent_even_when_nobody_is_in_view(tmp_path):
    rep, c = make_reporter(tmp_path)
    rep.report_detections(10, 64, 48, [], {}, lambda track: None)
    [m] = c.of_type("detections")
    assert m["people"] == [] and m["pts"] == 10 and (m["width"], m["height"]) == (64, 48)


# ================================================================================================
# 6. StreamHubServer: video in, results out, on one connection per camera
# ================================================================================================

class FakeConsumer:
    def __init__(self, camera_id, publish):
        self.camera_id, self.publish, self.frames = camera_id, publish, []
        self.got = threading.Event()

    def handle_nalu(self, nalu, pts=None):
        self.frames.append((pts, nalu))
        self.publish({"type": "detections", "camera_id": self.camera_id, "pts": pts})
        self.got.set()


def start_server(tenant_in_handshake=True):
    opened, closed = [], []

    def open_camera(tenant, camera, publish):
        c = FakeConsumer(camera, publish)
        opened.append((tenant, c))
        return c

    server = StreamHubServer("127.0.0.1", 0, tenant_in_handshake, "default", open_camera, closed.append)
    server.start()
    return server, opened, closed


def wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_server_feeds_nalus_with_pts_and_sends_results_back():
    server, opened, closed = start_server()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as hub:
            write_message(hub, b"demo-facility")
            write_message(hub, b"cam-9")
            write_frame(hub, 4242, b"\x00\x00\x00\x01\x67hello")
            assert wait_for(lambda: opened and opened[0][1].frames)
            tenant, consumer = opened[0]
            assert tenant == "demo-facility" and consumer.camera_id == "cam-9"
            assert consumer.frames == [(4242, b"\x00\x00\x00\x01\x67hello")]
            assert read_json(hub) == {"type": "detections", "camera_id": "cam-9", "pts": 4242}
        assert wait_for(lambda: closed), "the camera was not closed when the hub disconnected"
        assert closed[0] is opened[0][1]
    finally:
        server.close()


def test_server_default_tenant_when_handshake_has_none():
    server, opened, _ = start_server(tenant_in_handshake=False)
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as hub:
            write_message(hub, b"cam-1")
            write_frame(hub, 1, b"\x41x")
            assert wait_for(lambda: opened and opened[0][1].frames)
            assert opened[0][0] == "default"
    finally:
        server.close()


def test_server_refuses_a_camera_the_runtime_rejects():
    closed = []
    server = StreamHubServer("127.0.0.1", 0, False, "default", lambda t, c, p: None, closed.append)
    server.start()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as hub:
            write_message(hub, b"cam-dup")
            hub.settimeout(5)
            assert hub.recv(1) == b""  # server closed the connection
        assert closed == []             # nothing was opened, so nothing to close
    finally:
        server.close()


def test_server_survives_garbage_and_keeps_accepting():
    server, opened, _ = start_server(tenant_in_handshake=False)
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as bad:
            bad.sendall(b"\xff\xff\xff\xff junk")  # absurd handshake length
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as good:
            write_message(good, b"cam-ok")
            write_frame(good, 7, b"\x41ok")
            assert wait_for(lambda: opened and opened[-1][1].frames)
    finally:
        server.close()


# ================================================================================================
# 7. The real pipeline, wired to a publish function (stub pose model, fake clock)
# ================================================================================================

LYING = np.zeros((17, 3), dtype=np.float32)
LYING[0] = (300, 400, 0.9)
LYING[5], LYING[6] = (270, 395, 0.9), (270, 405, 0.9)
LYING[11], LYING[12] = (170, 395, 0.9), (170, 405, 0.9)
LYING[13], LYING[14] = (110, 395, 0.9), (110, 405, 0.9)
LYING[15], LYING[16] = (55, 395, 0.9), (55, 405, 0.9)


class StubPose:
    def __init__(self):
        self.people = True

    def __call__(self, frame):
        if not self.people:
            return []
        return [Person(1, np.array([40, 380, 320, 420], dtype=np.float32), 0.9, LYING)]


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(pipeline_module.time, "time", lambda: now[0])
    return now


def test_pipeline_publishes_detections_recording_and_snapshot(tmp_path, clock):
    cfg = Config()
    c = Collect()
    sink = FanoutSink([c])
    p = pipeline_module.CameraPipeline("t", "cam-1", cfg, sink, IncidentAggregator({}, 10),
                                       SnapshotStore(str(tmp_path)), publish=c.publish)
    p.pose = StubPose()
    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    for i in range(60):  # 6 s of someone lying on the floor
        clock[0] += 0.1
        p.submit(frame, pts=5000 + i)
        p.step()

    detections = c.of_type("detections")
    assert len(detections) >= 50
    last = detections[-1]
    assert last["people"][0]["label"] in ("lying", "falling")
    assert last["people"][0]["box"] == [0.0625, 0.7917, 0.5, 0.875]
    assert last["pts"] >= 5000 and (last["width"], last["height"]) == (640, 480)
    assert [m["action"] for m in c.of_type("recording")] == ["start"]
    assert len(c.of_type("snapshot")) == 1
    assert [m["event"] for m in c.of_type("incident")][0] == "incident_started"
    # The detections carry the same incident ID the recording command used.
    start_id = c.of_type("recording")[0]["incident_id"]
    assert any(d["people"] and d["people"][0]["incident_id"] == start_id for d in detections)

    # Nobody in view any more: an empty detections message clears the overlay.
    p.pose.people = False
    clock[0] += 0.1
    p.submit(frame, pts=9999)
    p.step()
    assert c.of_type("detections")[-1]["people"] == []

    # The hub disconnects: the open incident becomes unresolved and recording stops.
    p.close()
    assert [m["action"] for m in c.of_type("recording")] == ["start", "stop"]
    assert c.of_type("incident")[-1]["event"] == "incident_unresolved"


def test_pipeline_end_to_end_from_h264_with_pts(tmp_path, clock, pictures):
    """Real H.264 in, through decoder and buffer, to detections out, tagged with the input PTS."""
    cfg = Config()
    c = Collect()
    p = pipeline_module.CameraPipeline("t", "cam-1", cfg, FanoutSink([c]), IncidentAggregator({}, 10),
                                       SnapshotStore(str(tmp_path)), publish=c.publish)
    p.pose = StubPose()
    base = 1_730_990_000_000
    for i, packet in enumerate(pictures):
        clock[0] += 0.1
        p.handle_nalu(packet, base + i * 100)
        p.step()
    pts_seen = [m["pts"] for m in c.of_type("detections")]
    assert pts_seen, "no detections came out of the decoded video"
    assert all(base <= v <= base + len(pictures) * 100 for v in pts_seen)
    assert pts_seen == sorted(pts_seen)
    assert (c.of_type("detections")[0]["width"], c.of_type("detections")[0]["height"]) == (128, 96)
