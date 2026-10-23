"""Wire protocol between stream-hub (internal/hub/ai_worker.go) and this service.

Handshake, sent once per connection:
    [u32 big-endian length][tenant_id utf-8]   (only when tenant_in_handshake is on)
    [u32 big-endian length][camera_id utf-8]

Then repeated until the connection closes:
    [u32 big-endian length][H.264 or H.265 NALU, with or without an Annex-B start code]

The codec is not signalled; ingest.decoder.detect_codec reads it from the parameter sets.
"""

import socket
import struct

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
