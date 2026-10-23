"""Dashcam-style clips: the in-memory loop, recordings, MP4 output and retention."""

import os
import time
from fractions import Fraction

import av
import numpy as np
import pytest

from clips import ClipConfig, ClipJob, ClipRecorder, ClipWriter, nal_kind


def split_annexb(data: bytes) -> list[bytes]:
    """Annex-B bytes -> NALUs with a 4-byte start code each (as the gateway sends them)."""
    out, i = [], 0
    starts = []
    while (i := data.find(b"\x00\x00\x01", i)) != -1:
        starts.append(i + 3)
        i += 3
    for k, s in enumerate(starts):
        end = starts[k + 1] - 3 if k + 1 < len(starts) else len(data)
        nalu = data[s:end].rstrip(b"\x00") if k + 1 < len(starts) else data[s:end]
        out.append(b"\x00\x00\x00\x01" + nalu)
    return out


def encode(encoder: str, frames: int, fps: int = 25, gop: int = 25) -> list[bytes]:
    enc = av.CodecContext.create(encoder, "w")
    enc.width, enc.height, enc.pix_fmt = 640, 360, "yuv420p"
    enc.time_base = Fraction(1, fps)
    enc.options = {"preset": "ultrafast", "tune": "zerolatency", "g": str(gop), "bf": "0"}
    if encoder == "libx265":
        enc.options["x265-params"] = f"log-level=error:keyint={gop}:min-keyint={gop}:bframes=0"
    packets = []
    for i in range(frames):
        img = np.zeros((360, 640, 3), np.uint8)
        img[:, (i * 7) % 640:] = 180
        f = av.VideoFrame.from_ndarray(img, format="bgr24").reformat(format="yuv420p")
        f.pts = i
        packets += [bytes(p) for p in enc.encode(f)]
    packets += [bytes(p) for p in enc.encode(None)]
    return packets


class Collect:
    """Stands in for ClipWriter: keeps submitted jobs."""
    def __init__(self):
        self.jobs: list[ClipJob] = []

    def submit(self, job):
        self.jobs.append(job)


@pytest.mark.parametrize("nalu, codec, expect", [
    (b"\x00\x00\x00\x01\x67\x42", "h264", (True, False, False)),   # SPS
    (b"\x00\x00\x00\x01\x65\x88", "h264", (False, True, True)),    # IDR, first slice
    (b"\x41\x9a", "h264", (False, False, True)),                   # P picture, first slice
    (b"\x41\x1a", "h264", (False, False, False)),                  # P slice, not the first of its picture
    (b"\x40\x01\x0c", "hevc", (True, False, False)),               # VPS
    (b"\x26\x01\xaf", "hevc", (False, True, True)),                # IDR_W_RADL, first slice
    (b"\x02\x01\xd0", "hevc", (False, False, True)),               # TRAIL_R, first slice
    (b"\x02\x01\x50", "hevc", (False, False, False)),              # TRAIL_R, later slice
])
def test_nal_kind(nalu, codec, expect):
    assert nal_kind(nalu, codec) == expect


def fake_stream(seconds: float, fps: int = 10, key_every_s: float = 2.0, t0: float = 1000.0):
    """(time, nalu) for an H.264-looking stream: SPS+PPS+IDR every key_every_s, P frames between."""
    out = []
    for i in range(int(seconds * fps)):
        t = t0 + i / fps
        if i % int(key_every_s * fps) == 0:
            out += [(t, b"\x67\x42\x00"), (t, b"\x68\xce"), (t, b"\x65\x88" + bytes(100))]
        else:
            out.append((t, b"\x41\x9a" + bytes(100)))
    return out


def test_loop_keeps_pre_roll_from_a_keyframe():
    rec = ClipRecorder("cam", "t", ClipConfig(pre_roll_s=5), Collect())
    stream = fake_stream(30)
    for t, n in stream:
        rec.feed(n, "h264", t)
    now = stream[-1][0]
    first_t, first_nalu, is_key, _ = rec._buf[0]
    assert is_key and now - 7 <= first_t <= now - 5  # keyframes every 2 s: 5-7 s kept
    assert rec.buffered_bytes < 10_000


def test_loop_respects_memory_cap():
    rec = ClipRecorder("cam", "t", ClipConfig(pre_roll_s=60, buffer_mb=0.005), Collect())  # ~5 KB
    for t, n in fake_stream(30):
        rec.feed(n, "h264", t)
    assert rec.buffered_bytes < 5 * 1024 + 3000  # at most one GOP over the cap


def test_recording_covers_before_and_after():
    writer = Collect()
    rec = ClipRecorder("cam", "tenant", ClipConfig(pre_roll_s=5, post_roll_s=3, max_s=60), writer)
    stream = fake_stream(40)
    fall_at, up_at = 1020.0, 1030.0
    for t, n in stream:
        if t == fall_at:
            rec.start("inc-1", t)
        if t == up_at:
            rec.stop("inc-1", t)
        rec.feed(n, "h264", t)
    [job] = writer.jobs
    assert job.incident_id == "inc-1" and job.camera_id == "cam" and job.tenant_id == "tenant"
    assert fall_at - 7 <= job.started_at <= fall_at - 5      # pre-roll, from a keyframe
    assert up_at + 3 <= job.ended_at <= up_at + 3.2           # post-roll
    assert job.nalus[0].startswith(b"\x67")                    # starts with the parameter sets
    assert job.pictures == pytest.approx((job.ended_at - job.started_at) * 10, abs=2)


def test_max_length_and_camera_disconnect():
    writer = Collect()
    rec = ClipRecorder("cam", "t", ClipConfig(pre_roll_s=2, max_s=10), writer)
    stream = fake_stream(40)
    for t, n in stream[:5]:
        rec.feed(n, "h264", t)
    rec.start("long", stream[4][0])
    for t, n in stream[5:]:
        rec.feed(n, "h264", t)
    assert len(writer.jobs) == 1 and writer.jobs[0].ended_at - writer.jobs[0].started_at <= 10.1
    rec.start("cut", stream[-1][0])
    rec.close()  # camera gone: what was recorded is saved
    assert [j.incident_id for j in writer.jobs] == ["long", "cut"]


def test_disabled_records_nothing():
    writer = Collect()
    rec = ClipRecorder("cam", "t", ClipConfig(enabled=False), writer)
    for t, n in fake_stream(5):
        rec.feed(n, "h264", t)
    rec.start("x", 1004)
    rec.close()
    assert writer.jobs == []


@pytest.mark.parametrize("encoder, codec", [("libx264", "h264"), ("libx265", "hevc")])
def test_writes_playable_h264_mp4(tmp_path, encoder, codec):
    """Real video in, recorded mid-stream; the clip is an H.264 MP4 of the right length."""
    if encoder not in av.codecs_available:
        pytest.skip(f"{encoder} not in this PyAV build")
    fps, seconds = 25, 8
    nalus = [n for p in encode(encoder, fps * seconds, fps) for n in split_annexb(p)]
    collect = Collect()
    rec = ClipRecorder("cam", "t", ClipConfig(pre_roll_s=2, post_roll_s=1, max_width=320), collect)
    t0, step = 1000.0, seconds / len(nalus)
    for i, n in enumerate(nalus):
        t = t0 + i * step
        if i == len(nalus) // 2:
            rec.start("inc", t)
        if i == int(len(nalus) * 0.75):
            rec.stop("inc", t)
        rec.feed(n, codec, t)
    rec.close()
    [job] = collect.jobs

    saved = []
    writer = ClipWriter(str(tmp_path), ClipConfig(max_width=320), on_saved=lambda j, k, s: saved.append((k, s)))
    try:
        key, clip_seconds = writer.write(job)
    finally:
        writer.close()
    assert key == "clips/inc_cam.mp4"
    with av.open(str(tmp_path / key)) as clip:
        stream = clip.streams.video[0]
        assert stream.codec_context.name == "h264"
        assert (stream.width, stream.height) == (320, 180)  # scaled down, even sizes
        frames = sum(1 for _ in clip.decode(stream))
    # From a keyframe 2-3 s before the start, to 1 s after the stop.
    assert 2.5 * fps <= frames <= 6.5 * fps
    assert clip_seconds == pytest.approx(frames / fps, rel=0.15)


def test_prune_by_age_and_total_size(tmp_path):
    writer = ClipWriter(str(tmp_path), ClipConfig(retention_days=1, max_total_gb=0.000002))  # 2 KB cap
    try:
        d = tmp_path / "clips"
        old = d / "old.mp4"
        old.write_bytes(b"x" * 100)
        os.utime(old, (time.time() - 3 * 86400,) * 2)
        for i, name in enumerate(["a.mp4", "b.mp4", "c.mp4"]):
            (d / name).write_bytes(b"x" * 900)
            os.utime(d / name, (time.time() - 100 + i,) * 2)
        writer.prune()
        assert sorted(p.name for p in d.glob("*.mp4")) == ["b.mp4", "c.mp4"]  # old by age, a by size
    finally:
        writer.close()
