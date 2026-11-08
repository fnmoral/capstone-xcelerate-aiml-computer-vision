"""Wire protocol between stream-hub (internal/hub/ai_worker.go) and this service.

Handshake, sent once per connection by stream-hub:
    [u32 big-endian length][tenant_id utf-8]   (only when tenant_in_handshake is on)
    [u32 big-endian length][camera_id utf-8]

Then, stream-hub -> ml-service, repeated until the connection closes:
    [u32 big-endian length][i64 big-endian PTS][H.264 or H.265 NALU]

    The PTS is the picture's capture time in Unix epoch milliseconds, set by the gateway.
    Every NALU of one picture (parameter sets, slices) carries the same PTS. The NALU may
    come with or without an Annex-B start code.

And ml-service -> stream-hub, on the same connection, whenever there is a result:
    [u32 big-endian length][JSON object, utf-8]

    See ingest.results for the message types. stream-hub relays them to the frontend
    without parsing them.

The codec is not signalled; ingest.decoder.detect_codec reads it from the parameter sets.
"""

import socket
import struct

MAX_ID_LEN = 256
MAX_NALU_LEN = 8 * 1024 * 1024
START_CODE = b"\x00\x00\x00\x01"

_LENGTH = struct.Struct(">I")
_FRAME_HEADER = struct.Struct(">Iq")  # NALU length, PTS


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
    header = recv_exact(sock, _LENGTH.size)
    if header is None:
        return None
    (length,) = _LENGTH.unpack(header)
    if length == 0 or length > max_len:
        raise ProtocolError(f"invalid message length {length}")
    payload = recv_exact(sock, length)
    if payload is None:
        raise ProtocolError("connection closed before payload")
    return payload


def read_frame(sock: socket.socket, max_len: int) -> tuple[int, bytes] | None:
    """Read one (pts, nalu) frame. Returns None when the peer closes cleanly."""
    header = recv_exact(sock, _FRAME_HEADER.size)
    if header is None:
        return None
    length, pts = _FRAME_HEADER.unpack(header)
    if length == 0 or length > max_len:
        raise ProtocolError(f"invalid frame length {length}")
    nalu = recv_exact(sock, length)
    if nalu is None:
        raise ProtocolError("connection closed before NALU")
    return pts, nalu


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
    sock.sendall(_LENGTH.pack(len(payload)) + payload)


def write_frame(sock: socket.socket, pts: int, nalu: bytes) -> None:
    """Send one frame the way stream-hub does (used by tools/send_video.py and tests)."""
    sock.sendall(_FRAME_HEADER.pack(len(nalu), pts) + nalu)


def to_annexb(nalu: bytes) -> bytes:
    if nalu.startswith(START_CODE) or nalu.startswith(b"\x00\x00\x01"):
        return nalu
    return START_CODE + nalu