import socket
import struct
import threading

import pytest

from ingest.protocol import ProtocolError, read_handshake, read_message, to_annexb, write_message


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
