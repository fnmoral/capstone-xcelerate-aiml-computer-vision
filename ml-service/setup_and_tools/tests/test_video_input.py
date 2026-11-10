"""Tests for app/camera_service/video_input.py: stream-hub's protocol, decoding, frame sampling.
"""

import random
import socket
import struct
import threading
from fractions import Fraction

import av
import numpy as np
import pytest

from app.camera_service.video_input import FrameSampler, ProtocolError, VideoDecoder, detect_codec, read_handshake, read_message, to_annexb, write_message


# ================================================================================================
# 1. Protocol
# ================================================================================================

def pair():
    return socket.socketpair()


def test_handshake_camera_only():
    a, b = pair()
    write_message(a, b"cam-1")
    assert read_handshake(b, False, "t-default") == ("t-default", "cam-1")


def test_handshake_with_tenant():
    a, b = pair()
    write_message(a, b"tenant-9")
    write_message(a, b"cam-1")
    assert read_handshake(b, True, "unused") == ("tenant-9", "cam-1")


def test_message_split_across_writes():
    a, b = pair()
    payload = b"\x65" * 5000

    def slow_writer():
        data = struct.pack(">I", len(payload)) + payload
        for i in range(0, len(data), 7):
            a.sendall(data[i:i + 7])

    t = threading.Thread(target=slow_writer)
    t.start()
    assert read_message(b, 1 << 20) == payload
    t.join()


def test_clean_close_returns_none():
    a, b = pair()
    a.close()
    assert read_message(b, 100) is None


def test_close_mid_message_raises():
    a, b = pair()
    a.sendall(struct.pack(">I", 10) + b"abc")
    a.close()
    with pytest.raises(ProtocolError):
        read_message(b, 100)


def test_rejects_oversized_length():
    a, b = pair()
    a.sendall(struct.pack(">I", 1000))
    with pytest.raises(ProtocolError):
        read_message(b, 100)


def test_to_annexb():
    assert to_annexb(b"\x65abc") == b"\x00\x00\x00\x01\x65abc"
    assert to_annexb(b"\x00\x00\x01\x65") == b"\x00\x00\x01\x65"


# ================================================================================================
# 2. Decoding
# ================================================================================================
#
# VideoDecoder: codec detection and real H.264 / H.265 decoding (as the gateway sends it).

@pytest.mark.parametrize("nalu, codec", [
    (b"\x40\x01\x0c\x01", "hevc"),        # H.265 VPS
    (b"\x42\x01\x01\x01", "hevc"),        # H.265 SPS
    (b"\x44\x01\xc1\x72", "hevc"),        # H.265 PPS
    (b"\x00\x00\x00\x01\x40\x01\x0c", "hevc"),  # with an Annex-B start code
    (b"\x67\x64\x00\x1f", "h264"),        # H.264 SPS
    (b"\x27\x42\x00\x1e", "h264"),        # H.264 SPS, nal_ref_idc 1
    (b"\x00\x00\x01\x67\x4d", "h264"),    # 3-byte start code
    (b"\x68\xee\x3c\x80", None),          # H.264 PPS: wait for the SPS
    (b"\x65\x88\x84", None),              # H.264 IDR slice
    (b"\x26\x01\xaf", None),              # H.265 IDR slice
    (b"\x40", None),                      # too short to be sure
    (b"\xc0\x01", None),                  # forbidden bit set
    (b"", None),
])
def test_detect_codec(nalu, codec):
    assert detect_codec(nalu) == codec


def encode(codec: str, frames: int = 12) -> list[bytes]:
    """Annex-B packets of a small moving test picture."""
    enc = av.CodecContext.create(codec, "w")
    enc.width, enc.height, enc.pix_fmt = 320, 240, "yuv420p"
    enc.time_base = Fraction(1, 25)
    enc.options = {"preset": "ultrafast", "tune": "zerolatency"}
    if codec == "libx265":
        enc.options["x265-params"] = "log-level=error"
    out = []
    for i in range(frames):
        img = np.zeros((240, 320, 3), np.uint8)
        img[:, (i * 20) % 320:] = 200
        frame = av.VideoFrame.from_ndarray(img, format="bgr24").reformat(format="yuv420p")
        frame.pts = i
        out += [bytes(p) for p in enc.encode(frame)]
    out += [bytes(p) for p in enc.encode(None)]
    return out


@pytest.mark.parametrize("encoder, codec", [("libx264", "h264"), ("libx265", "hevc")])
def test_decodes_real_stream(encoder, codec):
    if encoder not in av.codecs_available:
        pytest.skip(f"{encoder} not in this PyAV build")
    dec = VideoDecoder("cam")
    frames = [f for packet in encode(encoder) for f in dec.decode(packet)]
    assert dec.codec == codec
    assert len(frames) >= 8
    assert VideoDecoder.to_bgr(frames[0]).shape == (240, 320, 3)


def test_waits_for_parameter_sets():
    """Joining mid-stream (e.g. after an ml-service restart): slices before the first
    parameter set are dropped, then decoding starts."""
    packets = encode("libx265" if "libx265" in av.codecs_available else "libx264")
    dec = VideoDecoder("cam")
    assert dec.decode(b"\x00\x00\x00\x01\x02\x01\xd0\x00") == []  # an H.265 P-slice: no codec yet
    assert dec.codec is None
    frames = [f for p in packets for f in dec.decode(p)]
    assert dec.codec is not None and frames


# ================================================================================================
# 3. Frame sampler
# ================================================================================================
#
# FrameSampler keeps the analysis rate at target_fps on average.

def accepted(fps_in: float, target: float, seconds: float = 30, jitter: float = 0.0) -> float:
    s = FrameSampler(target)
    rng = random.Random(1)
    t, n = 0.0, 0
    while t < seconds:
        n += s.accept(t + rng.uniform(-jitter, jitter))
        t += 1 / fps_in
    return n / seconds


@pytest.mark.parametrize("fps_in, expected", [(15, 10), (25, 10), (30, 10), (10, 10), (8, 8), (5, 5)])
def test_rate_is_the_target_or_the_camera_rate(fps_in, expected):
    assert accepted(fps_in, 10) == pytest.approx(expected, rel=0.03)


def test_jittery_camera_at_the_target_rate():
    # A 10 fps camera whose frames arrive +-20 ms off schedule is still analysed at ~10 fps.
    assert accepted(10, 10, jitter=0.02) == pytest.approx(10, rel=0.05)


def test_no_burst_after_a_pause():
    s = FrameSampler(10)
    assert s.accept(0.0)
    # 5 s without video, then frames every 10 ms: only one catch-up slot, not 50.
    burst = sum(s.accept(5.0 + i * 0.01) for i in range(10))
    assert burst <= 2
