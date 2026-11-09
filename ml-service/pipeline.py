"""Per-camera processing: decode -> sample -> pose -> rules -> incidents -> zones -> sink.

Threading: reader threads call handle_nalu() / submit() / close(), which never touch
PyTorch. The main thread calls step(), which runs the model. PyTorch 2.14 on Python 3.15
crashes the process when any tensor is created off the main thread.

Results go to `publish`, which for stream-hub cameras sends them back on the camera's
connection: detections and incident events for the frontend, and for stream-hub itself the
incident snapshots and when to start and stop recording a clip (stream-hub keeps the video).
"""

import logging
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from config import Config
from fall.features import extract
from fall.rules import LYING, FALLING, RuleClassifier
from fall.state_machine import RECOVERED, STARTED, UNRESOLVED, FallMonitor, IncidentEvent
from fall.zones import IncidentAggregator
from ingest.decoder import FrameSampler, VideoDecoder
from ingest.results import (detections_message, incident_message, person_entry, recording_message,
                            snapshot_message)
from sinks import (Sink, SnapshotStore, clip_key, clip_record, incident_record, prediction_record, snapshot_key,
                   snapshot_name)
from vision.pose import Person, PoseTracker

log = logging.getLogger(__name__)

LABEL_COLORS = {LYING: (0, 0, 255), FALLING: (0, 165, 255)}
RATE_WINDOW_S = 30.0  # rates() averages over this long
SNAPSHOT_JPEG_QUALITY = 85

Publish = Callable[[dict], None]


def wall_clock_pts() -> int:
    """Current time as a PTS (Unix epoch ms), for sources that don't carry one."""
    return int(time.time() * 1000)


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: Sink,
                 aggregator: IncidentAggregator, snapshots: SnapshotStore,
                 overrides=None, publish: Publish | None = None):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.cfg = cfg
        self.sink = sink
        self.aggregator = aggregator
        self.snapshots = snapshots      # local snapshots, for sources without stream-hub
        self.overrides = overrides or (lambda tenant: {})  # tenant -> settings changed in the frontend
        self.publish = publish          # results for the frontend; None for sources nobody watches live
        # Counters for the periodic stats log line; read and reset by take_stats().
        self.frames_in = 0
        self.frames_analysed = 0
        self.model_ms = 0.0
        self._stats_since = time.monotonic()
        self._connected_at = self._stats_since
        self._received_times: deque[float] = deque()  # monotonic times, last RATE_WINDOW_S
        self._receiving = False  # set by the first frame; see _count_received_locked
        self._analysed_times: deque[float] = deque()
        self.decoder = VideoDecoder(camera_id)
        self.sampler = FrameSampler(cfg.inference.target_fps)
        target = cfg.inference.target_fps
        self._convert_interval = 1.0 / (2 * target) if target > 0 else 0.0
        self._next_convert = 0.0
        self.pose: PoseTracker | None = None  # created by step(), on the main thread
        self.classifier = RuleClassifier(cfg.rules)
        self.model_name = f"{Path(cfg.inference.weights).name}+{self.classifier.name}"  # e.g. yolo26n-pose.pt+rules
        self.monitor = FallMonitor(cfg.monitor)
        self._last_prediction: dict[int, float] = {}
        self._pending: np.ndarray | None = None
        self._pending_pts: int = 0  # PTS of _pending (Unix epoch ms)
        self._pending_lock = threading.Lock()
        self._monitor_lock = threading.Lock()  # step() on the main thread vs close() from a reader thread
        # For the preview window: newest annotated frame and who is in it.
        self.latest_annotated: np.ndarray | None = None
        self.latest_people: list[dict] = []
        self.latest_at: float | None = None

    def handle_nalu(self, nalu: bytes, pts: int | None = None) -> None:
        """Feed one NALU. pts is its picture's PTS (Unix epoch ms) when the source has one."""
        frames = self.decoder.decode(nalu, pts)
        for frame in frames:
            now = time.monotonic()
            # Convert at most twice the analysis rate, so a fresh frame is always waiting
            # without paying the BGR conversion for frames that would be thrown away.
            if now >= self._next_convert:
                self._next_convert = now + self._convert_interval
                self.submit(VideoDecoder.to_bgr(frame), frame.pts if pts is not None else None)
            else:
                with self._pending_lock:
                    self._count_received_locked()

    def submit(self, frame: np.ndarray, pts: int | None = None) -> None:
        """Hand over a decoded BGR frame and its PTS (now, if None).
        Only the newest one is kept, so a slow model never falls behind."""
        with self._pending_lock:
            self._pending = frame
            self._pending_pts = pts if pts is not None else wall_clock_pts()
            self._count_received_locked()

    def _count_received_locked(self) -> None:
        """Count a received frame. Caller holds _pending_lock.

        The first frame starts the stats and rate windows. Before it the camera was only
        connected (a stream-hub camera waits for its first keyframe, which can take several
        seconds), and counting that wait made a healthy camera look slow in the first stats line.
        """
        now = time.monotonic()
        if not self._receiving:
            self._receiving = True
            self._stats_since = self._connected_at = now
        self.frames_in += 1
        self._received_times.append(now)

    def rates(self) -> tuple[float, float]:
        """(frames received, frames analysed) per second, averaged over the last RATE_WINDOW_S
        (or since the camera connected, if that is shorter). Safe from any thread."""
        now = time.monotonic()
        window = max(min(RATE_WINDOW_S, now - self._connected_at), 1.0)
        with self._pending_lock:
            for times in (self._received_times, self._analysed_times):
                while times and times[0] < now - window:
                    times.popleft()
            return len(self._received_times) / window, len(self._analysed_times) / window

    def take_stats(self) -> tuple[int, int, float, float]:
        """(frames received, frames analysed, total model ms, seconds covered) since the last call.

        The first window starts when the camera connected, not at the previous stats line,
        so a camera that joins mid-window isn't reported as slow.
        """
        now = time.monotonic()
        with self._pending_lock:
            stats = (self.frames_in, self.frames_analysed, self.model_ms, max(now - self._stats_since, 1e-6))
            self.frames_in = self.frames_analysed = 0
            self.model_ms = 0.0
            self._stats_since = now
        return stats

    def close(self) -> None:
        """The camera disconnected: its open incidents become unresolved. Safe from any thread."""
        with self._monitor_lock:
            for event in self.monitor.close_all(time.time()):
                self._report(event, None)

    def _report(self, event: IncidentEvent, frame: np.ndarray | None, pts: int | None = None) -> None:
        # Asked before handle(): once a member closes, the aggregator forgets it.
        incident_id = self.aggregator.incident_id_for(event.incident)
        reports = self.aggregator.handle(self.tenant_id, self.camera_id, event)
        # After handle(): a new incident only has an ID now.
        current_id = self.aggregator.incident_id_for(event.incident) or incident_id
        # Every camera that confirmed the fall records its own clip of it (in stream-hub).
        if event.kind == STARTED and current_id:
            self._publish(recording_message(self.camera_id, "start", current_id))
        elif event.kind in (RECOVERED, UNRESOLVED) and incident_id:
            self._publish(recording_message(self.camera_id, "stop", incident_id))
            if self.publish is not None:
                # stream-hub saves the clip post_roll_s from now under this key.
                self.sink.clip(clip_record(self.tenant_id, incident_id, self.camera_id,
                                           clip_key(incident_id, self.camera_id), None))
        for kind, zone_incident in reports:
            # Each camera that confirms the fall contributes its own snapshot.
            key = None
            if frame is not None and event.kind == STARTED:
                key = self._save_snapshot(zone_incident, frame)
            self.sink.incident(incident_record(kind, zone_incident, event.at, key, self.camera_id if key else None))
            self._publish(incident_message(self.camera_id, pts, kind, current_id, zone_incident.severity,
                                           zone_incident.zone, zone_incident.cameras))
            log.info("[%s] %s zone=%s cameras=%s severity=%s", self.camera_id, kind, zone_incident.zone,
                     ",".join(zone_incident.cameras), zone_incident.severity)

    def _save_snapshot(self, zone_incident, frame: np.ndarray) -> str | None:
        """Send this camera's snapshot to stream-hub (or save it locally for other sources)."""
        if self.publish is None:
            return self.snapshots.save(zone_incident, self.camera_id, frame)
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, SNAPSHOT_JPEG_QUALITY])
        if not ok:
            log.warning("[%s] could not encode the snapshot of incident %s", self.camera_id, zone_incident.id)
            return None
        name = snapshot_name(zone_incident, self.camera_id)
        self._publish(snapshot_message(self.camera_id, zone_incident.id, name, jpeg.tobytes()))
        return snapshot_key(name)

    def _publish(self, message: dict) -> None:
        if self.publish is None:
            return
        try:
            self.publish(message)
        except Exception:
            log.exception("[%s] could not publish a result", self.camera_id)

    def step(self) -> bool:
        """Run the model on the newest frame if one is due. Main thread only. Returns True if it ran."""
        now = time.time()
        with self._pending_lock:
            if self._pending is None or not self.sampler.accept(now):
                return False
            frame, pts, self._pending = self._pending, self._pending_pts, None
        if self.pose is None:
            inf = self.cfg.inference
            self.pose = PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half)
        # Minimum person confidence can be changed in the frontend (Detection Settings).
        self.pose.conf = self.overrides(self.tenant_id).get("person_confidence", self.cfg.inference.conf)
        with self._monitor_lock:
            self._process(frame, now, pts)
        return True

    def _process(self, frame: np.ndarray, now: float, pts: int) -> None:
        start = time.perf_counter()
        people = self.pose(frame)
        elapsed_ms = (time.perf_counter() - start) * 1000
        inference_ms = int(elapsed_ms)
        with self._pending_lock:
            self.frames_analysed += 1
            self._analysed_times.append(time.monotonic())
            self.model_ms += elapsed_ms

        labels: dict[int, tuple[str, float]] = {}
        for person in people:
            features = extract(person.box, person.keypoints, frame.shape[0], self.cfg.rules_min_kpt_conf)
            velocity = self.monitor.hip_velocity(person.track_id, now, features.hip_y)
            label, confidence = self.classifier.classify(features, velocity)
            labels[person.track_id] = (label, confidence)

            for event in self.monitor.update(now, person.track_id, label, confidence):
                self._report(event, frame, pts)

            if now - self._last_prediction.get(person.track_id, 0.0) >= self.cfg.prediction_interval_s:
                self._last_prediction[person.track_id] = now
                self.sink.prediction(prediction_record(
                    self.tenant_id, self.camera_id, now, self.model_name, self.classifier.version,
                    label, confidence,
                    {
                        "track_id": person.track_id,
                        "box": person.box.round(1).tolist(),
                        "keypoints": person.keypoints.round(3).tolist(),
                        "torso_angle_deg": features.torso_angle_deg,
                        "aspect_ratio": features.aspect_ratio,
                        "hip_velocity": velocity,
                    },
                    inference_ms,
                    self.aggregator.incident_id_for(self.monitor.incident_of(person.track_id)),
                ))

        for event in self.monitor.expire(now):
            self._report(event, None, pts)

        self._publish_detections(frame, pts, people, labels)

        self.latest_people = [{"track": t, "label": label, "confidence": round(conf, 2)}
                              for t, (label, conf) in sorted(labels.items())]
        self.latest_at = now
        if self.cfg.show:
            self.latest_annotated = self._annotate(frame, people, labels)

    def _publish_detections(self, frame: np.ndarray, pts: int, people: list[Person],
                            labels: dict[int, tuple[str, float]]) -> None:
        """Send who is where in this frame, also when nobody is (so the overlay clears)."""
        if self.publish is None:
            return
        height, width = frame.shape[:2]
        entries = []
        for p in people:
            label, conf = labels[p.track_id]
            incident_id = self.aggregator.incident_id_for(self.monitor.incident_of(p.track_id))
            entries.append(person_entry(p.track_id, label, conf, p.box, width, height, incident_id))
        self._publish(detections_message(self.camera_id, pts, width, height, entries))

    def _annotate(self, frame: np.ndarray, people: list[Person],
                  labels: dict[int, tuple[str, float]]) -> np.ndarray:
        img = frame.copy()
        for p in people:
            label, conf = labels[p.track_id]
            color = LABEL_COLORS.get(label, (0, 200, 0))
            x1, y1, x2, y2 = p.box.astype(int)
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
            cv2.putText(img, f"#{p.track_id} {label} {conf:.2f}", (x1, max(y1 - 8, 16)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
        cv2.putText(img, self.camera_id, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (255, 255, 255), 2, cv2.LINE_AA)
        return img