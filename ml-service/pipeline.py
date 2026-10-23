"""Per-camera processing: decode -> sample -> pose -> rules -> incidents -> zones -> sink.

Threading: reader threads call handle_nalu() / submit() / close(), which never touch
PyTorch. The main thread calls step(), which runs the model. PyTorch 2.14 on Python 3.15
crashes the process when any tensor is created off the main thread.
"""

import logging
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from config import Config
from fall.features import extract
from fall.rules import LYING, FALLING, RuleClassifier
from fall.state_machine import STARTED, FallMonitor, IncidentEvent
from fall.zones import IncidentAggregator
from ingest.decoder import FrameSampler, H264Decoder
from sinks import Sink, SnapshotStore, incident_record, prediction_record
from vision.pose import Person, PoseTracker

log = logging.getLogger(__name__)

LABEL_COLORS = {LYING: (0, 0, 255), FALLING: (0, 165, 255)}


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: Sink,
                 aggregator: IncidentAggregator, snapshots: SnapshotStore):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.cfg = cfg
        self.sink = sink
        self.aggregator = aggregator
        self.snapshots = snapshots
        # Counters for the periodic stats log line; read and reset by take_stats().
        self.frames_in = 0
        self.frames_analysed = 0
        self.model_ms = 0.0
        self.decoder = H264Decoder(camera_id)
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
        self._pending_lock = threading.Lock()
        self._monitor_lock = threading.Lock()  # step() on the main thread vs close() from a reader thread
        self.latest_annotated: np.ndarray | None = None

    def handle_nalu(self, nalu: bytes) -> None:
        for frame in self.decoder.decode(nalu):
            now = time.monotonic()
            # Convert at most twice the analysis rate, so a fresh frame is always waiting
            # without paying the BGR conversion for frames that would be thrown away.
            if now >= self._next_convert:
                self._next_convert = now + self._convert_interval
                self.submit(H264Decoder.to_bgr(frame))
            else:
                with self._pending_lock:
                    self.frames_in += 1

    def submit(self, frame: np.ndarray) -> None:
        """Hand over a decoded BGR frame. Only the newest one is kept, so a slow model never falls behind."""
        with self._pending_lock:
            self._pending = frame
            self.frames_in += 1

    def take_stats(self) -> tuple[int, int, float]:
        """(frames received, frames analysed, total model ms) since the last call."""
        with self._pending_lock:
            stats = (self.frames_in, self.frames_analysed, self.model_ms)
            self.frames_in = self.frames_analysed = 0
            self.model_ms = 0.0
        return stats

    def close(self) -> None:
        """The camera disconnected: its open incidents become unresolved. Safe from any thread."""
        with self._monitor_lock:
            for event in self.monitor.close_all(time.time()):
                self._report(event, None)

    def _report(self, event: IncidentEvent, frame: np.ndarray | None) -> None:
        for kind, zone_incident in self.aggregator.handle(self.tenant_id, self.camera_id, event):
            # Each camera that confirms the fall contributes its own snapshot.
            key = None
            if frame is not None and event.kind == STARTED:
                key = self.snapshots.save(zone_incident, self.camera_id, frame)
            self.sink.incident(incident_record(kind, zone_incident, event.at, key, self.camera_id if key else None))
            log.info("[%s] %s zone=%s cameras=%s severity=%s", self.camera_id, kind, zone_incident.zone,
                     ",".join(zone_incident.cameras), zone_incident.severity)

    def step(self) -> bool:
        """Run the model on the newest frame if one is due. Main thread only. Returns True if it ran."""
        now = time.time()
        with self._pending_lock:
            if self._pending is None or not self.sampler.accept(now):
                return False
            frame, self._pending = self._pending, None
        if self.pose is None:
            inf = self.cfg.inference
            self.pose = PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half)
        with self._monitor_lock:
            self._process(frame, now)
        return True

    def _process(self, frame: np.ndarray, now: float) -> None:
        start = time.perf_counter()
        people = self.pose(frame)
        elapsed_ms = (time.perf_counter() - start) * 1000
        inference_ms = int(elapsed_ms)
        with self._pending_lock:
            self.frames_analysed += 1
            self.model_ms += elapsed_ms

        labels: dict[int, tuple[str, float]] = {}
        for person in people:
            features = extract(person.box, person.keypoints, frame.shape[0], self.cfg.rules_min_kpt_conf)
            velocity = self.monitor.hip_velocity(person.track_id, now, features.hip_y)
            label, confidence = self.classifier.classify(features, velocity)
            labels[person.track_id] = (label, confidence)

            for event in self.monitor.update(now, person.track_id, label, confidence):
                self._report(event, frame)

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
            self._report(event, None)

        if self.cfg.show:
            self.latest_annotated = self._annotate(frame, people, labels)

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
