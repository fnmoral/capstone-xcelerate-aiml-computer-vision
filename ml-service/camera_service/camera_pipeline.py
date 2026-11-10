"""One camera from video frames to incidents, and merging incidents across cameras.

1. CameraPipeline: newest frame -> pose model -> fall detector -> incidents -> results.
2. Zones: cameras that see the same area raise one alert per fall, not one per camera.
"""

import logging
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from camera_service.clips import ClipRecorder
from camera_service.results import Sink, SnapshotStore, incident_record, prediction_record
from camera_service.video_input import FrameSampler, VideoDecoder
from config import Config
from detection.fall_detection import FALLING, FallDetector, Incident, IncidentEvent, LYING, RECOVERED, STARTED, UNCLEAR, UNRESOLVED, UPDATED
from detection.pose_model import Person, PoseTracker


# ================================================================================================
# 1. CameraPipeline: one camera, from frames to incidents
# ================================================================================================
#
# Per-camera processing: decode -> sample -> pose -> rules -> incidents -> zones -> sink.
#
# Threading: reader threads call handle_nalu() / submit() / close(), which never touch
# PyTorch. The main thread calls step(), which runs the model. PyTorch 2.14 on Python 3.15
# crashes the process when any tensor is created off the main thread.

log = logging.getLogger(__name__)

LABEL_COLORS = {LYING: (0, 0, 255), FALLING: (0, 165, 255), UNCLEAR: (160, 160, 160)}
RATE_WINDOW_S = 30.0  # rates() averages over this long


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: Sink,
                 aggregator: IncidentAggregator, snapshots: SnapshotStore,
                 clips: ClipRecorder | None = None, overrides=None):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.cfg = cfg
        self.sink = sink
        self.aggregator = aggregator
        self.snapshots = snapshots
        self.clips = clips              # dashcam-style clip recorder (stream-hub cameras only)
        self.overrides = overrides or (lambda tenant: {})  # tenant -> settings changed in the frontend
        # Counters for the periodic stats log line; read and reset by take_stats().
        self.frames_in = 0
        self.frames_analysed = 0
        self.model_ms = 0.0
        self._stats_since = time.monotonic()
        self._connected_at = self._stats_since
        self._received_times: deque[float] = deque()  # monotonic times, last RATE_WINDOW_S
        self._analysed_times: deque[float] = deque()
        self.decoder = VideoDecoder(camera_id)
        self.sampler = FrameSampler(cfg.inference.target_fps)
        target = cfg.inference.target_fps
        self._convert_interval = 1.0 / (2 * target) if target > 0 else 0.0
        self._next_convert = 0.0
        self.pose: PoseTracker | None = None  # created by step(), on the main thread
        self.detector = FallDetector(cfg.rules, cfg.monitor, cfg.detector)
        self.classifier = self.detector.classifier
        self.model_name = f"{Path(cfg.inference.weights).name}+{self.classifier.name}"  # e.g. yolo26n-pose.pt+rules
        self._last_prediction: dict[int, float] = {}
        self._pending: np.ndarray | None = None
        self._pending_lock = threading.Lock()
        self._monitor_lock = threading.Lock()  # step() on the main thread vs close() from a reader thread
        # For the preview window and the viewer: newest annotated frame and who is in it.
        self.latest_annotated: np.ndarray | None = None
        self.latest_people: list[dict] = []
        self.latest_at: float | None = None

    def handle_nalu(self, nalu: bytes) -> None:
        frames = self.decoder.decode(nalu)
        if self.clips is not None:
            self.clips.feed(nalu, self.decoder.codec)
        for frame in frames:
            now = time.monotonic()
            # Convert at most twice the analysis rate, so a fresh frame is always waiting
            # without paying the BGR conversion for frames that would be thrown away.
            if now >= self._next_convert:
                self._next_convert = now + self._convert_interval
                self.submit(VideoDecoder.to_bgr(frame))
            else:
                with self._pending_lock:
                    self.frames_in += 1
                    self._received_times.append(time.monotonic())

    def submit(self, frame: np.ndarray) -> None:
        """Hand over a decoded BGR frame. Only the newest one is kept, so a slow model never falls behind."""
        with self._pending_lock:
            self._pending = frame
            self.frames_in += 1
            self._received_times.append(time.monotonic())

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
            for event in self.detector.close_all(time.time()):
                self._report(event, None)
        if self.clips is not None:
            self.clips.close()

    def _report(self, event: IncidentEvent, frame: np.ndarray | None) -> None:
        # Asked before handle(): once a member closes, the aggregator forgets it.
        incident_id = self.aggregator.incident_id_for(event.incident)
        reports = self.aggregator.handle(self.tenant_id, self.camera_id, event)
        if self.clips is not None:
            # Every camera that confirmed the fall records its own clip of it.
            if event.kind == STARTED:
                if zone_id := self.aggregator.incident_id_for(event.incident):
                    self.clips.start(zone_id)
            elif event.kind in (RECOVERED, UNRESOLVED) and incident_id:
                self.clips.stop(incident_id)
        for kind, zone_incident in reports:
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
            self.pose = PoseTracker.from_config(self.cfg.inference)
        # Minimum person confidence can be changed in the frontend (Detection Settings).
        self.pose.conf = self.overrides(self.tenant_id).get("person_confidence", self.cfg.inference.conf)
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
            self._analysed_times.append(time.monotonic())
            self.model_ms += elapsed_ms

        results, events = self.detector.process(now, people, frame.shape)
        for event in events:
            self._report(event, frame)

        labels: dict[int, tuple[str, float]] = {}
        for person, r in zip(people, results):
            labels[r.track_id] = (r.label, r.confidence)
            if now - self._last_prediction.get(r.track_id, 0.0) >= self.cfg.prediction_interval_s:
                self._last_prediction[r.track_id] = now
                self.sink.prediction(prediction_record(
                    self.tenant_id, self.camera_id, now, self.model_name, self.classifier.version,
                    r.label, r.confidence,
                    {
                        "track_id": r.track_id,
                        "box": person.box.round(1).tolist(),
                        "keypoints": person.keypoints.round(3).tolist(),
                        "torso_angle_deg": r.features.torso_angle_deg,
                        "aspect_ratio": r.features.aspect_ratio,
                        "hip_velocity": r.hip_velocity,
                    },
                    inference_ms,
                    self.aggregator.incident_id_for(self.detector.incident_of(r.track_id)),
                ))

        for event in self.detector.expire(now):
            self._report(event, None)

        self.latest_people = [{"track": t, "label": label, "confidence": round(conf, 2)}
                              for t, (label, conf) in sorted(labels.items())]
        self.latest_at = now
        if self.cfg.show or self.cfg.viewer_enabled:
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


# ================================================================================================
# 2. Zones: one alert per fall across cameras that see the same area
# ================================================================================================
#
# Merges incidents from cameras that watch the same area, so one fall gives one alert.
#
# Cameras are grouped into zones in config.yaml. Each camera's FallMonitor still tracks its
# own people; this layer sits between the monitors and the sink. When a camera confirms a
# fall in a zone that already has an open incident which started within merge_window_s, the
# new one joins it instead of raising a second alert.
#
# The merged incident:
# - starts at the earliest member's start and lists every camera that saw it
# - takes the highest severity and confidence of any member
# - closes when every member has closed: `recovered` if any camera saw the person get up,
#   otherwise `unresolved`
#
# Only incidents from *different* cameras merge: two people falling on the same camera are
# already told apart by that camera's tracker and stay separate incidents.
#
# Limitation: two different people falling within the window, each seen by a *different*
# camera of the same zone, are merged. Telling them apart needs cross-camera identity (a
# shared floor plan), not built yet.

SEVERITY_ORDER = ("medium", "high", "critical")


@dataclass(slots=True)
class ZoneIncident:
    id: str
    zone: str
    tenant_id: str
    started_at: float
    members: dict[int, tuple[str, Incident]] = field(default_factory=dict)  # id(Incident) -> (camera, incident)
    cameras: list[str] = field(default_factory=list)   # every camera that saw it, first one first
    tracks: list[str] = field(default_factory=list)    # "camera#track" for each member
    severity: str = "medium"
    peak_confidence: float = 0.0
    recovered_at: float | None = None
    status: str = "active"

    @property
    def camera_id(self) -> str:
        return self.cameras[0]


class IncidentAggregator:
    def __init__(self, zones: dict[str, list[str]], merge_window_s: float):
        self.merge_window_s = merge_window_s
        self._zone_of = {cam: name for name, cams in zones.items() for cam in cams}
        self._open: list[ZoneIncident] = []
        self._by_member: dict[int, ZoneIncident] = {}
        self._lock = threading.Lock()  # main thread, plus reader threads closing a lost camera

    def set_zones(self, zones: dict[str, list[str]]) -> None:
        """Replace the zone map (e.g. after zones were edited in the database).

        Open incidents keep their zone; only new falls use the new map.
        """
        with self._lock:
            self._zone_of = {cam: name for name, cams in zones.items() for cam in cams}

    def zones(self) -> dict[str, list[str]]:
        with self._lock:
            out: dict[str, list[str]] = {}
            for cam, name in self._zone_of.items():
                out.setdefault(name, []).append(cam)
            return out

    def incident_id_for(self, inc: Incident | None) -> str | None:
        """ID of the zone incident a camera-level incident belongs to, if it is still open."""
        if inc is None:
            return None
        with self._lock:
            group = self._by_member.get(id(inc))
            return group.id if group is not None else None

    def zone_of(self, camera_id: str) -> str:
        # A camera without a zone is its own zone, so nothing is merged into it.
        # (Called with self._lock held, from _start.)
        return self._zone_of.get(camera_id, f"camera:{camera_id}")

    def handle(self, tenant_id: str, camera_id: str, event: IncidentEvent) -> list[tuple[str, ZoneIncident]]:
        """Feed one camera-level event; returns the zone-level events to report (often none)."""
        with self._lock:
            match event.kind:
                case "incident_started":
                    return self._start(tenant_id, camera_id, event.incident)
                case "incident_updated":
                    return self._update(event.incident)
                case "incident_recovered" | "incident_unresolved":
                    return self._close(event.kind, event.incident)
        return []

    def _start(self, tenant_id: str, camera_id: str, inc: Incident) -> list[tuple[str, ZoneIncident]]:
        zone = self.zone_of(camera_id)
        # Only merge across cameras: a second person falling on the same camera is a separate
        # incident (that camera's tracker already tells them apart).
        candidates = [g for g in self._open
                      if g.zone == zone and g.tenant_id == tenant_id
                      and abs(inc.started_at - g.started_at) <= self.merge_window_s
                      and all(cam != camera_id for cam, _ in g.members.values())]
        group = min(candidates, key=lambda g: abs(inc.started_at - g.started_at), default=None)
        is_new = group is None
        if is_new:
            group = ZoneIncident(str(uuid.uuid4()), zone, tenant_id, inc.started_at)
            self._open.append(group)

        group.members[id(inc)] = (camera_id, inc)
        self._by_member[id(inc)] = group
        group.started_at = min(group.started_at, inc.started_at)
        if camera_id not in group.cameras:
            group.cameras.append(camera_id)
        group.tracks.append(f"{camera_id}#{inc.track_id}")
        self._refresh(group)
        # A camera joining an open incident is reported as an update, not a new alert.
        return [(STARTED if is_new else UPDATED, group)]

    def _update(self, inc: Incident) -> list[tuple[str, ZoneIncident]]:
        group = self._by_member.get(id(inc))
        if group is None:
            return []
        before = group.severity
        self._refresh(group)
        return [(UPDATED, group)] if group.severity != before else []

    def _close(self, kind: str, inc: Incident) -> list[tuple[str, ZoneIncident]]:
        group = self._by_member.pop(id(inc), None)
        if group is None:
            return []
        self._refresh(group)  # keep the member's final numbers
        group.members.pop(id(inc), None)
        if kind == RECOVERED and inc.recovered_at is not None:
            group.recovered_at = inc.recovered_at if group.recovered_at is None else min(group.recovered_at, inc.recovered_at)
        if group.members:
            return []
        self._open.remove(group)
        group.status = "recovered" if group.recovered_at is not None else "unresolved"
        return [(RECOVERED if group.status == "recovered" else UNRESOLVED, group)]

    @staticmethod
    def _refresh(group: ZoneIncident) -> None:
        for _, inc in group.members.values():
            group.peak_confidence = max(group.peak_confidence, inc.peak_confidence)
            if SEVERITY_ORDER.index(inc.severity) > SEVERITY_ORDER.index(group.severity):
                group.severity = inc.severity
