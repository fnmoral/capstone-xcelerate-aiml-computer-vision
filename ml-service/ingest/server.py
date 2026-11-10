"""TCP server for stream-hub: one connection per camera, video in and results out."""

import logging
import socket
import threading
from typing import Callable, Protocol

from ingest.protocol import MAX_NALU_LEN, ProtocolError, read_frame, read_handshake
from ingest.results import Publish, ResultWriter

log = logging.getLogger(__name__)


class FrameConsumer(Protocol):
    """What a connection feeds: in practice a pipeline.CameraPipeline."""

    camera_id: str

    def handle_nalu(self, nalu: bytes, pts: int | None = None) -> None: ...


# open_camera(tenant_id, camera_id, publish) -> consumer, or None to refuse the camera
OpenCamera = Callable[[str, str, Publish], FrameConsumer | None]
CloseCamera = Callable[[FrameConsumer], None]


class StreamHubServer:
    """Accepts stream-hub connections, feeds their NALUs to a consumer per camera, and
    gives each consumer a publish function that sends results back on the same connection."""

    def __init__(self, host: str, port: int, tenant_in_handshake: bool, default_tenant_id: str,
                 open_camera: OpenCamera, close_camera: CloseCamera):
        self._host = host
        self._port = port
        self._tenant_in_handshake = tenant_in_handshake
        self._default_tenant_id = default_tenant_id
        self._open_camera = open_camera
        self._close_camera = close_camera
        self._server: socket.socket | None = None

    @property
    def port(self) -> int:
        """The bound port (useful when started with port 0)."""
        return self._server.getsockname()[1] if self._server else self._port

    def start(self) -> None:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self._host, self._port))
        server.listen()
        self._server = server
        log.info("listening for stream-hub on %s:%d", self._host, self.port)
        threading.Thread(target=self._accept_loop, name="stream-hub-accept", daemon=True).start()

    def close(self) -> None:
        if self._server is not None:
            self._server.close()

    def _accept_loop(self) -> None:
        while True:
            try:
                conn, addr = self._server.accept()
            except OSError:
                return  # closed
            threading.Thread(target=self._handle, args=(conn, addr), daemon=True).start()

    def _handle(self, conn: socket.socket, addr) -> None:
        # Disable Nagle's algorithm: this connection carries many small, latency-sensitive
        # messages (one write per NALU, one per result), not a big bulk transfer. Without
        # this, Python (unlike Go) leaves Nagle on, which can add tens to hundreds of ms of
        # delay per write and shows up as video arriving in bursts instead of steadily.
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        camera_id = "?"
        consumer: FrameConsumer | None = None
        writer: ResultWriter | None = None
        try:
            tenant_id, camera_id = read_handshake(conn, self._tenant_in_handshake, self._default_tenant_id)
            log.info("camera [%s] tenant [%s] connected from %s", camera_id, tenant_id, addr)
            writer = ResultWriter(conn, camera_id)
            consumer = self._open_camera(tenant_id, camera_id, writer.publish)
            if consumer is None:
                return
            while (frame := read_frame(conn, MAX_NALU_LEN)) is not None:
                pts, nalu = frame
                consumer.handle_nalu(nalu, pts)
        except (ProtocolError, OSError, UnicodeDecodeError) as e:
            log.warning("camera [%s] connection error: %s", camera_id, e)
        finally:
            if consumer is not None:
                self._close_camera(consumer)  # open incidents become unresolved
            if writer is not None:
                writer.close()
            try:
                conn.shutdown(socket.SHUT_RDWR)  # also wakes a writer blocked in sendall
            except OSError:
                pass
            conn.close()
            log.info("camera [%s] disconnected", camera_id)