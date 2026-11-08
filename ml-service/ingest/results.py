"""Results sent back to stream-hub, which relays them to the frontend over its WebSocket.

Messages are JSON objects with a "type" field:

detections: one per analysed frame, also when nobody is in view (so the frontend clears
its overlay). Boxes are normalised to 0..1 as [x1, y1, x2, y2] so they can be drawn at
any display size; width and height are the analysed frame's size in pixels.

    {"type": "detections", "camera_id": "cam1", "pts": 1730990000123,
     "width": 1280, "height": 720,
     "people": [{"track": 1, "label": "lying", "confidence": 0.91,
                 "box": [0.12, 0.30, 0.45, 0.88], "incident_id": "..." | null}]}

incident: a zone-level incident event (started, updated, recovered, unresolved).

    {"type": "incident", "camera_id": "cam1", "pts": 1730990000123 | null,
     "event": "incident_started", "incident_id": "...", "severity": "medium",
     "zone": "...", "cameras": ["cam1"]}
"""

import json
import logging
import queue
import socket
import threading

from ingest.protocol import write_message

log = logging.getLogger(__name__)

_STOP = object()


def detections_message(camera_id: str, pts: int, width: int, height: int, people: list[dict]) -> dict:
    return {"type": "detections", "camera_id": camera_id, "pts": int(pts),
            "width": int(width), "height": int(height), "people": people}


def person_entry(track: int, label: str, confidence: float, box, width: int, height: int,
                 incident_id: str | None) -> dict:
    """One person of a detections message. box is [x1, y1, x2, y2] in pixels."""
    x1, y1, x2, y2 = (float(v) for v in box)
    norm = [x1 / width, y1 / height, x2 / width, y2 / height]
    return {"track": int(track), "label": str(label), "confidence": round(float(confidence), 2),
            "box": [round(min(max(v, 0.0), 1.0), 4) for v in norm],
            "incident_id": incident_id}


def incident_message(camera_id: str, pts: int | None, event: str, incident_id: str | None,
                     severity: str, zone: str, cameras) -> dict:
    return {"type": "incident", "camera_id": camera_id, "pts": None if pts is None else int(pts),
            "event": str(event), "incident_id": incident_id, "severity": str(severity),
            "zone": str(zone), "cameras": [str(c) for c in cameras]}


class ResultWriter:
    """Sends result messages on a stream-hub connection from its own thread.

    publish() never blocks: inference runs on the main thread for every camera, so a slow
    or stuck stream-hub must not hold it up. When the queue is full the oldest message is
    dropped; a newer detection replaces an older one anyway.
    """

    def __init__(self, sock: socket.socket, camera_id: str, max_queue: int = 256):
        self._sock = sock
        self._camera_id = camera_id
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue)
        self._closed = threading.Event()
        self._dropped = 0
        self._thread = threading.Thread(target=self._run, name=f"results-{camera_id}", daemon=True)
        self._thread.start()

    def publish(self, message: dict) -> None:
        """Queue a message for sending. Safe from any thread."""
        if not self._closed.is_set():
            self._put(message)

    def close(self) -> None:
        """Stop after what is already queued. Does not wait for the thread."""
        if not self._closed.is_set():
            self._closed.set()
            self._put(_STOP)

    def _put(self, item) -> None:
        while True:
            try:
                self._queue.put_nowait(item)
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                    self._dropped += 1
                    if self._dropped % 100 == 1:
                        log.warning("[%s] stream-hub is not reading results; dropped %d so far",
                                    self._camera_id, self._dropped)
                except queue.Empty:
                    pass

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                return
            try:
                write_message(self._sock, json.dumps(item, separators=(",", ":")).encode("utf-8"))
            except OSError as e:
                log.debug("[%s] results connection closed: %s", self._camera_id, e)
                self._closed.set()
                return