"""Video coming in from stream-hub: its TCP messages, and decoding them into frames.

1. Protocol: the handshake and length-prefixed H.264/H.265 chunks stream-hub sends.
2. Decoding: chunks into frames, and picking only as many frames as the model needs.
"""

import logging
import socket
import struct

import av
import numpy as np


# ================================================================================================
# 1. Protocol: reading stream-hub's messages
# ================================================================================================
#
# Wire protocol between stream-hub (internal/hub/ai_worker.go) and this service.
#
# Handshake, sent once per connection:
#     [u32 big-endian length][tenant_id utf-8]   (only when tenant_in_handshake is on)
#     [u32 big-endian length][camera_id utf-8]
#
# Then repeated until the connection closes:
#     [u32 big-endian length][H.264 or H.265 NALU, with or without an Annex-B start code]
#
# The codec is not signalled; ingest.decoder.detect_codec reads it from the parameter sets.

MAX_ID_LEN = 256
MAX_NALU_LEN = 8 * 1024 * 1024
START_CODE = b"\x00\x00\x00\x01"


class ProtocolError(Exception):
    pass


def recv_exact(sock: socket.socket, n: int) -> bytes | None:
    """Read exactly n bytes. Returns None on a clean close before the first byte."""
    buf = bytearray(n)
    view = memoryview(buf)
    got = 0
    while got < n:
        k = sock.recv_into(view[got:], n - got)
        if k == 0:
            if got == 0:
                return None
            raise ProtocolError(f"connection closed after {got} of {n} bytes")
        got += k
    return bytes(buf)


def read_message(sock: socket.socket, max_len: int) -> bytes | None:
    """Read one length-prefixed message. Returns None when the peer closes cleanly."""
    header = recv_exact(sock, 4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length == 0 or length > max_len:
        raise ProtocolError(f"invalid message length {length}")
    payload = recv_exact(sock, length)
    if payload is None:
        raise ProtocolError("connection closed before payload")
    return payload


def read_handshake(sock: socket.socket, tenant_in_handshake: bool, default_tenant: str) -> tuple[str, str]:
    """Return (tenant_id, camera_id) from the start of a connection."""
    tenant = default_tenant
    if tenant_in_handshake:
        raw = read_message(sock, MAX_ID_LEN)
        if raw is None:
            raise ProtocolError("connection closed before tenant_id")
        tenant = raw.decode("utf-8")

    raw = read_message(sock, MAX_ID_LEN)
    if raw is None:
        raise ProtocolError("connection closed before camera_id")
    return tenant, raw.decode("utf-8")


def write_message(sock: socket.socket, payload: bytes) -> None:
    sock.sendall(struct.pack(">I", len(payload)) + payload)


def to_annexb(nalu: bytes) -> bytes:
    if nalu.startswith(START_CODE) or nalu.startswith(b"\x00\x00\x01"):
        return nalu
    return START_CODE + nalu


# ================================================================================================
# 2. Decoding: video chunks into frames, and the frame sampler
# ================================================================================================
#
# H.264 / H.265 decoding and frame-rate sampling for one camera.

log = logging.getLogger(__name__)


def detect_codec(nalu: bytes) -> str | None:
    """'h264' or 'hevc' if this NALU is a parameter set that identifies the codec, else None.

    stream-hub doesn't say which codec a camera uses, so it is read from the stream: the
    gateway sends the parameter sets first, and cameras repeat them before keyframes.
    The two codecs' parameter-set headers never collide:
      * H.265 VPS / SPS / PPS (types 32-34) start with 0x40 / 0x42 / 0x44 (an even byte;
        layer 0) followed by a temporal-id byte of at least 1. As H.264 headers those would
        be types 0, 2 and 4, which cameras don't send.
      * An H.264 SPS (type 7) starts with an odd byte (0x67, 0x47, 0x27), which is never a
        valid single-layer H.265 header.
    """
    if nalu.startswith(b"\x00\x00\x00\x01"):
        nalu = nalu[4:]
    elif nalu.startswith(b"\x00\x00\x01"):
        nalu = nalu[3:]
    if not nalu or nalu[0] & 0x80:  # forbidden_zero_bit must be 0 in both codecs
        return None
    b0 = nalu[0]
    if b0 & 0x01 == 0 and (b0 >> 1) & 0x3F in (32, 33, 34) and len(nalu) > 1 and nalu[1] & 0x07:
        return "hevc"
    if b0 & 0x1F == 7:
        return "h264"
    return None


class VideoDecoder:
    """Decodes a stream of H.264 or H.265 NALUs into video frames. One instance per camera.

    The codec is detected from the first parameter set (see detect_codec); NALUs before it
    are dropped, as nothing can be decoded without one.

    Every frame has to be decoded (frames depend on each other), but converting to a BGR
    array is the expensive part, so callers convert only the frames they will analyse.
    """

    def __init__(self, camera_id: str):
        self.camera_id = camera_id
        self.codec: str | None = None  # 'h264' or 'hevc' once detected
        self._codec: av.CodecContext | None = None
        self._errors = 0
        self._skipped = 0

    @staticmethod
    def to_bgr(frame: av.VideoFrame) -> np.ndarray:
        return frame.to_ndarray(format="bgr24")

    def decode(self, nalu: bytes) -> list[av.VideoFrame]:
        if self._codec is None:
            codec = detect_codec(nalu)
            if codec is None:
                self._skipped += 1
                if self._skipped == 300:
                    log.warning("[%s] no H.264 / H.265 parameter set yet after %d packets: "
                                "is the camera sending H.264 or H.265?", self.camera_id, self._skipped)
                return []
            self.codec = codec
            self._codec = av.CodecContext.create(codec, "r")
            log.info("[%s] video codec: %s", self.camera_id, "H.265" if codec == "hevc" else "H.264")

        frames: list[av.VideoFrame] = []
        try:
            for packet in self._codec.parse(to_annexb(nalu)):
                frames.extend(self._codec.decode(packet))
        except av.FFmpegError as e:
            # Expected until the first keyframe arrives, or after the hub drops NALUs.
            self._errors += 1
            if self._errors % 100 == 1:
                log.warning("[%s] decode error #%d: %s", self.camera_id, self._errors, e)
        return frames


class FrameSampler:
    """Lets through target_fps frames per second on average, so inference keeps up with the stream.

    The next slot is counted from the previous slot, not from the frame that took it:
    "at least 1/target_fps apart" would turn a 15 fps camera into 7.5 fps at a target of 10
    (every second frame), and a jittery 10 fps camera into ~7.
    """

    def __init__(self, target_fps: float):
        self._interval = 1.0 / target_fps if target_fps > 0 else 0.0
        self._next = 0.0

    def accept(self, now: float) -> bool:
        if now < self._next:
            return False
        # At most one slot of catch-up, so a pause in the video isn't followed by a burst.
        self._next = max(self._next + self._interval, now)
        return True
