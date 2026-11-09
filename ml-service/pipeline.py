"""Per-camera processing: decode -> sample -> pose -> rules -> incidents -> zones -> report.

Threading: reader threads call handle_nalu() / submit() / close(), which never touch
PyTorch. The main thread calls step(), which runs the model. PyTorch 2.14 on Python 3.15
crashes the process when any tensor is created off the main thread.

What happens to the results lives in two collaborators, not here:
  - ingest.buffer.FrameBuffer: the newest decoded frame plus the throughput counters
    behind the stats log line and the Detection Settings page.
  - reporting.IncidentReporter: incident/zone events and per-frame detections, sent to
    the sink (database) and to stream-hub (recording commands, snapshots, live messages).
"""

import logging
import threading
import time
from pathlib import Path

import numpy as np

from config import Config
from fall.features import extract
from fall.rules import RuleClassifier
from fall.state_machine import FallMonitor
from fall.zones import IncidentAggregator
from ingest.buffer import FrameBuffer
from ingest.decoder import FrameSampler, VideoDecoder
from ingest.results import Publish
from reporting import IncidentReporter
from sinks import Sink, SnapshotStore
from vision.overlay import annotate
from vision.pose import PoseTracker

log = logging.getLogger(__name__)


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: Sink,
                 aggregator: IncidentAggregator, snapshots: SnapshotStore,
                 overrides=None, publish: Publish | None = None):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.cfg = cfg
        self.aggregator = aggregator
        self.overrides = overrides or (lambda tenant: {})  # tenant -> settings changed in the frontend
        self.reporter = IncidentReporter(tenant_id, camera_id, sink, aggregator, snapshots, publish)

        self.decoder = VideoDecoder(camera_id)
        self.sampler = FrameSampler(cfg.inference.target_fps)
        target = cfg.inference.target_fps
        self._convert_interval = 1.0 / (2 * target) if target > 0 else 0.0
        self._next_convert = 0.0
        self.buffer = FrameBuffer()

        self.pose: PoseTracker | None = None  # created by step(), on the main thread
        self.classifier = RuleClassifier(cfg.rules)
        self.model_name = f"{Path(cfg.inference.weights).name}+{self.classifier.name}"  # e.g. yolo26n-pose.pt+rules
        self.monitor = FallMonitor(cfg.monitor)
        self._last_prediction: dict[int, float] = {}
        self._monitor_lock = threading.Lock()  # step() on the main thread vs close() from a reader thread

        # For the preview window: newest annotated frame and who is in it.
        self.latest_annotated: np.ndarray | None = None
        self.latest_people: list[dict] = []
        self.latest_at: float | None = None

    def handle_nalu(self, nalu: bytes, pts: int | None = None) -> None:
        """Feed one NALU. pts is its picture's PTS (Unix epoch ms) when the source has one."""
        for frame in self.decoder.decode(nalu, pts):
            now = time.monotonic()
            # Convert at most twice the analysis rate, so a fresh frame is always waiting
            # without paying the BGR conversion for frames that would be thrown away.
            if now >= self._next_convert:
                self._next_convert = now + self._convert_interval
                self.submit(VideoDecoder.to_bgr(frame), frame.pts if pts is not None else None)
            else:
                self.buffer.count_received()

    def submit(self, frame: np.ndarray, pts: int | None = None) -> None:
        """Hand over a decoded BGR frame and its PTS (now, if None).
        Only the newest one is kept, so a slow model never falls behind."""
        self.buffer.submit(frame, pts)

    def rates(self) -> tuple[float, float]:
        """(frames received, frames analysed) per second; see FrameBuffer.rates()."""
        return self.buffer.rates()

    def take_stats(self) -> tuple[int, int, float, float]:
        """(frames received, frames analysed, total model ms, seconds covered); see
        FrameBuffer.take_stats()."""
        return self.buffer.take_stats()

    def close(self) -> None:
        """The camera disconnected: its open incidents become unresolved. Safe from any thread."""
        with self._monitor_lock:
            for event in self.monitor.close_all(time.time()):
                self.reporter.report(event, None)

    def step(self) -> bool:
        """Run the model on the newest frame if one is due. Main thread only. Returns True if it ran."""
        due = self.buffer.take_due(self.sampler, time.time())
        if due is None:
            return False
        frame, pts = due
        if self.pose is None:
            inf = self.cfg.inference
            self.pose = PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half)
        # Minimum person confidence can be changed in the frontend (Detection Settings).
        self.pose.conf = self.overrides(self.tenant_id).get("person_confidence", self.cfg.inference.conf)
        with self._monitor_lock:
            self._process(frame, time.time(), pts)
        return True

    def _process(self, frame: np.ndarray, now: float, pts: int) -> None:
        start = time.perf_counter()
        people = self.pose(frame)
        elapsed_ms = (time.perf_counter() - start) * 1000
        inference_ms = int(elapsed_ms)
        self.buffer.record_analysed(elapsed_ms)

        labels: dict[int, tuple[str, float]] = {}
        for person in people:
            features = extract(person.box, person.keypoints, frame.shape[0], self.cfg.rules_min_kpt_conf)
            velocity = self.monitor.hip_velocity(person.track_id, now, features.hip_y)
            label, confidence = self.classifier.classify(features, velocity)
            labels[person.track_id] = (label, confidence)

            for event in self.monitor.update(now, person.track_id, label, confidence):
                self.reporter.report(event, frame, pts)

            if now - self._last_prediction.get(person.track_id, 0.0) >= self.cfg.prediction_interval_s:
                self._last_prediction[person.track_id] = now
                self.reporter.report_prediction(
                    self.tenant_id, now, self.model_name, self.classifier.version, label, confidence,
                    {
                        "track_id": person.track_id,
                        "box": person.box.round(1).tolist(),
                        "keypoints": person.keypoints.round(3).tolist(),
                        "torso_angle_deg": features.torso_angle_deg,
                        "aspect_ratio": features.aspect_ratio,
                        "hip_velocity": velocity,
                    },
                    inference_ms,
                    self._incident_id(person.track_id),
                )

        for event in self.monitor.expire(now):
            self.reporter.report(event, None, pts)

        height, width = frame.shape[:2]
        self.reporter.report_detections(pts, width, height, people, labels, self._incident_id)

        self.latest_people = [{"track": t, "label": label, "confidence": round(conf, 2)}
                              for t, (label, conf) in sorted(labels.items())]
        self.latest_at = now
        if self.cfg.show:
            self.latest_annotated = annotate(frame, self.camera_id, people, labels)

    def _incident_id(self, track_id: int) -> str | None:
        """The zone incident this person is currently part of, if any."""
        return self.aggregator.incident_id_for(self.monitor.incident_of(track_id))