"""Per-camera processing: decode -> sample -> pose -> rules -> incidents -> sink."""

import logging
import time

import cv2
import numpy as np

from config import Config
from fall.features import extract
from fall.rules import LYING, FALLING, RuleClassifier
from fall.state_machine import STARTED, FallMonitor
from ingest.decoder import FrameSampler, H264Decoder
from sinks.jsonl import JsonlSink
from vision.pose import Person, PoseTracker

log = logging.getLogger(__name__)

LABEL_COLORS = {LYING: (0, 0, 255), FALLING: (0, 165, 255)}


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: JsonlSink):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.cfg = cfg
        self.sink = sink
        self.decoder = H264Decoder(camera_id)
        self.sampler = FrameSampler(cfg.inference.target_fps)
        self.pose = PoseTracker(cfg.inference.weights, cfg.inference.device, cfg.inference.conf,
                                cfg.inference.imgsz, cfg.inference.tracker)
        self.classifier = RuleClassifier(cfg.rules)
        self.monitor = FallMonitor(cfg.monitor)
        self._last_prediction: dict[int, float] = {}
        self.latest_annotated: np.ndarray | None = None

    def handle_nalu(self, nalu: bytes) -> None:
        for frame in self.decoder.decode(nalu):
            now = time.time()
            if self.sampler.accept(now):
                self._process(frame, now)

    def _process(self, frame: np.ndarray, now: float) -> None:
        start = time.perf_counter()
        people = self.pose(frame)
        inference_ms = int((time.perf_counter() - start) * 1000)

        labels: dict[int, tuple[str, float]] = {}
        for person in people:
            features = extract(person.box, person.keypoints, frame.shape[0], self.cfg.rules_min_kpt_conf)
            velocity = self.monitor.hip_velocity(person.track_id, now, features.hip_y)
            label, confidence = self.classifier.classify(features, velocity)
            labels[person.track_id] = (label, confidence)

            for event in self.monitor.update(now, person.track_id, label, confidence):
                snapshot = frame if event.kind == STARTED else None
                self.sink.incident(self.tenant_id, self.camera_id, event, snapshot)
                log.info("[%s] %s track=%d severity=%s", self.camera_id, event.kind,
                         person.track_id, event.incident.severity)

            if now - self._last_prediction.get(person.track_id, 0.0) >= self.cfg.prediction_interval_s:
                self._last_prediction[person.track_id] = now
                self.sink.prediction(
                    self.tenant_id, self.camera_id, now,
                    f"{self.cfg.inference.weights}+{self.classifier.name}", self.classifier.version,
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
                )

        for event in self.monitor.expire(now):
            self.sink.incident(self.tenant_id, self.camera_id, event, None)

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
