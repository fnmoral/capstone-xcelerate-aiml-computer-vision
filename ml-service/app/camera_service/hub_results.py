"""Results sent back to stream-hub on the camera's connection.

Messages are JSON objects with a "type" field. stream-hub relays some to the frontend
over its WebSocket and acts on the others itself.

Relayed to the frontend:

detections: one per analysed frame, also when nobody is in view (so the frontend clears
its overlay). Boxes are normalised to 0..1 as [x1, y1, x2, y2] so they can be drawn at
any display size; width and height are the analysed frame's size in pixels.

    {"type": "detections", "camera_id": "cam1", "pts": 1730990000123,
     "width": 1280, "height": 720,
     "people": [{"track": 1, "label": "lying", "confidence": 0.91,
                 "box": [0.12, 0.30, 0.45, 0.88], "incident_id": "..." | null,
                 "keypoints": [[0.21, 0.35, 0.98], ...]}]}   # 17 COCO points: x, y (0..1), confidence

incident: a zone-level incident event (started, updated, recovered, unresolved).

    {"type": "incident", "camera_id": "cam1", "pts": 1730990000123 | null,
     "event": "incident_started", "incident_id": "...", "severity": "medium",
     "zone": "...", "cameras": ["cam1"]}

For stream-hub, which records clips and stores snapshots:

recording: start or finish this camera's clip of an incident. stream-hub saves it as
clips/<incident_id>_<camera_id>.mp4 (see results.clip_key).

    {"type": "recording", "camera_id": "cam1", "action": "start" | "stop", "incident_id": "..."}

snapshot: the frame on which this camera confirmed the fall, as a base64 JPEG.
stream-hub saves it as snapshots/<name> (see results.snapshot_key).

    {"type": "snapshot", "camera_id": "cam1", "incident_id": "...", "name": "<id>.jpg",
     "jpeg": "<base64>"}
"""

import base64
import json
import logging
import socket
import threading
from collections import deque
from typing import Callable

from app.camera_service.video_input import write_message

log = logging.getLogger(__name__)

# Signature stream-hub connections and tests use to send a result: Publish(message_dict).
Publish = Callable[[dict], None]


def detections_message(camera_id: str, pts: int, width: int, height: int, people: list[dict]) -> dict:
    return {"type": "detections", "camera_id": camera_id, "pts": int(pts),
            "width": int(width), "height": int(height), "people": people}


def person_entry(track: int, label: str, confidence: float, box, width: int, height: int,
                 incident_id: str | None, keypoints=None) -> dict:
    """One person of a detections message. box is [x1, y1, x2, y2] in pixels; keypoints,
    if given, the (17, 3) COCO body points as x, y in pixels and confidence. The frontend
    draws the skeleton from them; points are normalised to 0..1 like the box."""
    x1, y1, x2, y2 = (float(v) for v in box)
    norm = [x1 / width, y1 / height, x2 / width, y2 / height]
    entry = {"track": int(track), "label": str(label), "confidence": round(float(confidence), 2),
             "box": [round(min(max(v, 0.0), 1.0), 4) for v in norm],
             "incident_id": incident_id}
    if keypoints is not None:
        entry["keypoints"] = [[round(float(x) / width, 4), round(float(y) / height, 4), round(float(c), 2)]
                              for x, y, c in keypoints]
    return entry


def incident_message(camera_id: str, pts: int | None, event: str, incident_id: str | None,
                     severity: str, zone: str, cameras) -> dict:
    return {"type": "incident", "camera_id": camera_id, "pts": None if pts is None else int(pts),
            "event": str(event), "incident_id": incident_id, "severity": str(severity),
            "zone": str(zone), "cameras": [str(c) for c in cameras]}


def recording_message(camera_id: str, action: str, incident_id: str) -> dict:
    return {"type": "recording", "camera_id": camera_id, "action": action, "incident_id": str(incident_id)}


def snapshot_message(camera_id: str, incident_id: str, name: str, jpeg: bytes) -> dict:
    return {"type": "snapshot", "camera_id": camera_id, "incident_id": str(incident_id), "name": name,
            "jpeg": base64.b64encode(jpeg).decode("ascii")}


class ResultWriter:
    """Sends result messages on a stream-hub connection from its own thread.

    publish() never blocks: inference runs on the main thread for every camera, so a slow
    or stuck stream-hub must not hold it up. Detections are kept in a short queue that
    drops the oldest when full (a newer detection replaces an older one anyway). Every
    other message (incidents, recording commands, snapshots) is rare and is never dropped,
    and goes out before queued detections.
    """

    def __init__(self, sock: socket.socket, camera_id: str, max_detections: int = 64):
        self._sock = sock
        self._camera_id = camera_id
        self._cond = threading.Condition()
        self._control: deque[dict] = deque()
        self._detections: deque[dict] = deque(maxlen=max_detections)
        self._closed = False
        self._dropped = 0
        self._thread = threading.Thread(target=self._run, name=f"results-{camera_id}", daemon=True)
        self._thread.start()

    def publish(self, message: dict) -> None:
        """Queue a message for sending. Safe from any thread."""
        with self._cond:
            if self._closed:
                return
            if message.get("type") == "detections":
                if len(self._detections) == self._detections.maxlen:
                    self._dropped += 1
                    if self._dropped % 100 == 1:
                        log.warning("[%s] stream-hub is not reading results; dropped %d detections so far",
                                    self._camera_id, self._dropped)
                self._detections.append(message)
            else:
                self._control.append(message)
            self._cond.notify()

    def close(self) -> None:
        """Stop after what is already queued. Does not wait for the thread."""
        with self._cond:
            self._closed = True
            self._cond.notify()

    def _next(self) -> dict | None:
        with self._cond:
            while not (self._control or self._detections or self._closed):
                self._cond.wait()
            if self._control:
                return self._control.popleft()
            if self._detections:
                return self._detections.popleft()
            return None  # closed and empty

    def _run(self) -> None:
        while (message := self._next()) is not None:
            try:
                write_message(self._sock, json.dumps(message, separators=(",", ":")).encode("utf-8"))
            except OSError as e:
                log.debug("[%s] results connection closed: %s", self._camera_id, e)
                with self._cond:
                    self._closed = True
                return