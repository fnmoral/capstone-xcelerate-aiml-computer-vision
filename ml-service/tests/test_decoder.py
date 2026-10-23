"""VideoDecoder: codec detection and real H.264 / H.265 decoding (as the gateway sends it)."""

from fractions import Fraction

import av
import numpy as np
import pytest

from ingest.decoder import VideoDecoder, detect_codec


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
