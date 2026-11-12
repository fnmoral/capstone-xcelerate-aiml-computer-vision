"""One camera from video frames to incidents, and merging incidents across cameras.

1. CameraPipeline: newest frame -> pose model -> fall detector -> incidents -> results.
2. Zones: cameras that see the same area raise one alert per fall, not one per camera.
"""

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.camera_service.frame_buffer import FrameBuffer
from app.camera_service.hub_results import Publish
from app.camera_service.incident_reporter import IncidentReporter
from app.camera_service.results import Sink, SnapshotStore
from app.camera_service.video_input import FrameSampler, VideoDecoder
from app.config import Config
from app.detection.fall_detection import FallDetector, Incident, IncidentEvent, RECOVERED, STARTED, UNRESOLVED, UPDATED
from app.detection.overlay import annotate
from app.detection.pose_model import PoseTracker


# ================================================================================================
# 1. CameraPipeline: one camera, from frames to incidents
# ================================================================================================
#
# Per-camera processing: decode -> sample -> pose -> detector -> incidents -> zones -> report.
#
# Threading: reader threads call handle_nalu() / submit() / close(), which never touch
# PyTorch. The main thread calls step(), which runs the model. PyTorch 2.14 on Python 3.15
# crashes the process when any tensor is created off the main thread.
#
# What happens to the results lives in two collaborators, not here:
#   - frame_buffer.FrameBuffer: the newest decoded frame plus the throughput counters
#     behind the stats log line and the Detection Settings page.
#   - incident_reporter.IncidentReporter: incident/zone events and per-frame detections, sent
#     to the sink (database) and to stream-hub (recording commands, snapshots, live messages).

log = logging.getLogger(__name__)


class CameraPipeline:
    def __init__(self, tenant_id: str, camera_id: str, cfg: Config, sink: Sink,
                 aggregator: "IncidentAggregator", snapshots: SnapshotStore,
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
        self.detector = FallDetector(cfg.rules, cfg.monitor, cfg.detector)
        self.classifier = self.detector.classifier
        self.model_name = f"{Path(cfg.inference.weights).name}+{self.classifier.name}"  # e.g. yolo26n-pose.pt+rules
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
            for event in self.detector.close_all(time.time()):
                self.reporter.report(event, None)

    def step(self) -> bool:
        """Run the model on the newest frame if one is due. Main thread only. Returns True if it ran."""
        due = self.buffer.take_due(self.sampler, time.time())
        if due is None:
            return False
        frame, pts = due
        if self.pose is None:
            self.pose = PoseTracker.from_config(self.cfg.inference)
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

        results, events = self.detector.process(now, people, frame.shape)
        for event in events:
            self.reporter.report(event, frame, pts)

        labels: dict[int, tuple[str, float]] = {}
        for person, r in zip(people, results):
            labels[r.track_id] = (r.label, r.confidence)
            if now - self._last_prediction.get(r.track_id, 0.0) >= self.cfg.prediction_interval_s:
                self._last_prediction[r.track_id] = now
                self.reporter.report_prediction(
                    self.tenant_id, now, self.model_name, self.classifier.version, r.label, r.confidence,
                    {
                        "track_id": r.track_id,
                        "box": person.box.round(1).tolist(),
                        "keypoints": person.keypoints.round(3).tolist(),
                        "torso_angle_deg": r.features.torso_angle_deg,
                        "aspect_ratio": r.features.aspect_ratio,
                        "hip_velocity": r.hip_velocity,
                    },
                    inference_ms,
                    self._incident_id(r.track_id),
                )

        for event in self.detector.expire(now):
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
        return self.aggregator.incident_id_for(self.detector.incident_of(track_id))


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
        self._tenant_ids: dict[str, str] = {}  # slug or UUID -> UUID (from the database)
        self._lock = threading.Lock()  # main thread, plus reader threads closing a lost camera

    def set_tenant_ids(self, tenant_ids: dict[str, str]) -> None:
        """Tenants by slug and by UUID, so a camera sending 'demo-facility' and one sending its
        UUID count as the same facility (otherwise their falls are never merged)."""
        with self._lock:
            self._tenant_ids = dict(tenant_ids)

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
            tenant_id = self._tenant_ids.get(tenant_id, tenant_id)
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
