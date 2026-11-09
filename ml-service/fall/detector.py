"""Fall detection for one camera: tracked poses in, labels and incident events out.

pipeline.py uses this for live cameras and eval/benchmark.py for the benchmark, so both
run exactly the same logic.
"""

from collections import deque
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from fall.features import L_HIP, L_SHOULDER, R_HIP, R_SHOULDER, PoseFeatures, extract
from fall.rules import RuleClassifier, RuleThresholds
from fall.state_machine import FallMonitor, Incident, IncidentEvent, MonitorConfig

VELOCITY_WINDOW_S = 0.5   # hip speed is the trend over this long (a fall takes under a second)
TORSO_WINDOW_S = 5.0      # body size is the median torso length over this long


class TrackedPose(Protocol):
    track_id: int
    box: np.ndarray        # (4,) x1, y1, x2, y2 in pixels
    keypoints: np.ndarray  # (17, 3) x, y, confidence in COCO order


@dataclass(slots=True)
class DetectorConfig:
    min_keypoint_conf: float = 0.3
    # A new track ID that appears where a person was lost this recently carries on that
    # person's state (e.g. the tracker renumbered them as they fell). 0 = off.
    handoff_seconds: float = 2.0


@dataclass(slots=True)
class PersonResult:
    track_id: int
    label: str
    confidence: float
    features: PoseFeatures
    hip_velocity: float | None  # torso lengths per second, > 0 = moving down


@dataclass(slots=True)
class _PoseTrack:
    hips: deque = field(default_factory=deque)    # (time, hip y in pixels)
    torso: deque = field(default_factory=deque)   # (time, shoulder-to-hip length in pixels)
    last_seen: float = 0.0
    box: np.ndarray | None = None


def _midpoint(kpts: np.ndarray, a: int, b: int, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in (a, b) if kpts[i, 2] >= min_conf]
    return np.mean(pts, axis=0) if pts else None


class FallDetector:
    """Keeps per-person state between frames, so create one instance per camera."""

    def __init__(self, rules: RuleThresholds, monitor: MonitorConfig, cfg: DetectorConfig | None = None):
        self.cfg = cfg or DetectorConfig()
        self.classifier = RuleClassifier(rules)
        self.monitor = FallMonitor(monitor)
        self._tracks: dict[int, _PoseTrack] = {}

    def process(self, t: float, people: list[TrackedPose],
                frame_shape: tuple[int, ...]) -> tuple[list[PersonResult], list[IncidentEvent]]:
        """Label every person in one frame and return the incident events it caused."""
        results: list[PersonResult] = []
        events: list[IncidentEvent] = []
        present = {p.track_id for p in people}
        for person in people:
            if person.track_id not in self._tracks:
                self._hand_over(person, t, present)
            track = self._tracks.setdefault(person.track_id, _PoseTrack())
            track.last_seen, track.box = t, np.asarray(person.box, dtype=float)
            features = extract(person.box, person.keypoints, frame_shape, self.cfg.min_keypoint_conf)
            velocity = self._hip_velocity(person, t)
            label, confidence = self.classifier.classify(features, velocity)
            results.append(PersonResult(person.track_id, label, confidence, features, velocity))
            events += self.monitor.update(t, person.track_id, label, confidence)
        return results, events

    def _hand_over(self, person: TrackedPose, t: float, present: set[int]) -> None:
        """Give a new track ID the state of a person lost nearby within handoff_seconds.

        Trackers often renumber someone as they fall, because the box suddenly changes shape.
        Without this the new ID starts from scratch and the confirmation timer restarts.
        """
        if self.cfg.handoff_seconds <= 0:
            return
        x1, y1, x2, y2 = person.box
        centre = np.array([(x1 + x2) / 2, (y1 + y2) / 2])
        best, best_dist = None, None
        for track_id, track in self._tracks.items():
            if track_id in present or track.box is None or t - track.last_seen > self.cfg.handoff_seconds:
                continue
            ox1, oy1, ox2, oy2 = track.box
            dist = float(np.linalg.norm(centre - [(ox1 + ox2) / 2, (oy1 + oy2) / 2]))
            # Near where they were: within 3/4 of their old box's longest side.
            if dist <= 0.75 * max(ox2 - ox1, oy2 - oy1) and (best_dist is None or dist < best_dist):
                best, best_dist = track_id, dist
        if best is not None:
            self._tracks[person.track_id] = self._tracks.pop(best)
            self.monitor.rename(best, person.track_id)

    def _hip_velocity(self, person: TrackedPose, t: float) -> float | None:
        """How fast the hips move down, in the person's own torso lengths per second.

        Measuring in body size rather than frame size makes a fall look the same near the
        camera and far from it. The speed is a straight-line fit over the last second, so
        one jittery keypoint doesn't make a spike.
        """
        track = self._tracks[person.track_id]
        kpts, min_conf = person.keypoints, self.cfg.min_keypoint_conf
        hips = _midpoint(kpts, L_HIP, R_HIP, min_conf)
        shoulders = _midpoint(kpts, L_SHOULDER, R_SHOULDER, min_conf)
        if hips is not None and shoulders is not None:
            track.torso.append((t, float(np.linalg.norm(shoulders - hips))))
        if hips is not None:
            track.hips.append((t, float(hips[1])))
        for q, keep in ((track.hips, VELOCITY_WINDOW_S), (track.torso, TORSO_WINDOW_S)):
            while q and q[0][0] < t - keep:
                q.popleft()

        if hips is None or len(track.hips) < 3 or track.hips[-1][0] - track.hips[0][0] < 0.2:
            return None
        ts, ys = np.array(track.hips).T
        slope = np.polyfit(ts - ts[0], ys, 1)[0]  # pixels per second
        if track.torso:
            body = float(np.median([length for _, length in track.torso]))
        else:
            x1, y1, x2, y2 = person.box
            body = max(x2 - x1, y2 - y1) / 3.0  # a torso is about a third of a person's length
        return float(slope / max(body, 1.0))

    def expire(self, t: float) -> list[IncidentEvent]:
        events = self.monitor.expire(t)
        for track_id in list(self._tracks):
            if not self.monitor.has_track(track_id):
                del self._tracks[track_id]
        return events

    def close_all(self, t: float) -> list[IncidentEvent]:
        self._tracks.clear()
        return self.monitor.close_all(t)

    def incident_of(self, track_id: int) -> Incident | None:
        return self.monitor.incident_of(track_id)
