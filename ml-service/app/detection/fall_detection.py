"""How a fall is detected, from one person's 17 body points to a fall incident.

This file is the fall-detection part of the model. pose_model.py finds the people and their
body points in each frame; everything after that happens here, in five steps:

1. Measurements: angles and shapes of one pose (torso angle, legs upright, box shape...).
2. Rules classifier ("Stage A"): labels each pose upright, falling, lying or unclear.
3. Learned classifier ("Stage B"): a small trained model that can replace the rules.
4. Incident timing: someone must stay down for a few seconds before an incident opens.
5. FallDetector: steps 1-4 for every person a camera sees. pipeline and benchmark both use it.
"""

import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np


# ================================================================================================
# 1. Measurements: angles and shapes of one pose
# ================================================================================================
#
# Geometric features of a single pose, used by the fall rules.

# COCO keypoint indices
NOSE = 0
L_SHOULDER, R_SHOULDER = 5, 6
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14
L_ANKLE, R_ANKLE = 15, 16


@dataclass(slots=True)
class PoseFeatures:
    torso_angle_deg: float | None  # 0 = upright, 90 = horizontal
    aspect_ratio: float            # box width / height; > 1 means wider than tall
    hip_y: float | None            # hip height as a fraction of frame height (0 = top)
    head_below_hips: bool | None
    legs_upright: float | None = None  # 1 = legs straight down under the hips (standing), 0 = legs flat
    visible: int = 17                  # keypoints at or above min_conf
    lower_body: bool = True            # any hip, knee or ankle visible
    at_edge: bool = False              # box touches the frame edge: the person may be cut off
    angle_source: str = "torso"        # "torso" (shoulders-hips), "body" (head-legs fallback) or "none"


def _midpoint(kpts: np.ndarray, a: int, b: int, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in (a, b) if kpts[i, 2] >= min_conf]
    if not pts:
        return None
    return np.mean(pts, axis=0)


def _legs_upright(kpts: np.ndarray, min_conf: float) -> float | None:
    """How far the ankles are below the hips, as a share of the leg's length (hip-knee-ankle).

    Standing or bending over: about 1. Sitting on a chair: about 0.5. Lying: about 0.
    Leg length is measured along the leg, so it doesn't depend on which way the body faces.
    """
    ratios = []
    for hip, knee, ankle in ((L_HIP, L_KNEE, L_ANKLE), (R_HIP, R_KNEE, R_ANKLE)):
        if min(kpts[hip, 2], kpts[knee, 2], kpts[ankle, 2]) < min_conf:
            continue
        length = np.linalg.norm(kpts[knee, :2] - kpts[hip, :2]) + np.linalg.norm(kpts[ankle, :2] - kpts[knee, :2])
        if length > 1.0:
            ratios.append((kpts[ankle, 1] - kpts[hip, 1]) / length)
    return float(np.mean(ratios)) if ratios else None


def _group_mean(kpts: np.ndarray, idx: range, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in idx if kpts[i, 2] >= min_conf]
    return np.mean(pts, axis=0) if pts else None


def _angle(top: np.ndarray, bottom: np.ndarray) -> float:
    dx, dy = top - bottom
    return math.degrees(math.atan2(abs(dx), abs(dy)))


EDGE_PX = 3


def extract(box: np.ndarray, kpts: np.ndarray, frame_shape: tuple[int, ...], min_conf: float) -> PoseFeatures:
    frame_h, frame_w = frame_shape[:2]
    x1, y1, x2, y2 = box
    aspect = float((x2 - x1) / max(y2 - y1, 1.0))
    at_edge = bool(x1 <= EDGE_PX or y1 <= EDGE_PX or x2 >= frame_w - 1 - EDGE_PX or y2 >= frame_h - 1 - EDGE_PX)
    visible = int((kpts[:, 2] >= min_conf).sum())

    shoulders = _midpoint(kpts, L_SHOULDER, R_SHOULDER, min_conf)
    hips = _midpoint(kpts, L_HIP, R_HIP, min_conf)
    lower = _group_mean(kpts, range(L_HIP, R_ANKLE + 1), min_conf)

    angle, source = None, "none"
    if shoulders is not None and hips is not None:
        angle, source = _angle(shoulders, hips), "torso"
    else:
        # No torso line: use the head/shoulders to the legs instead.
        upper = _group_mean(kpts, range(NOSE, R_SHOULDER + 1), min_conf)
        if upper is not None and lower is not None:
            angle, source = _angle(upper, lower), "body"

    hip_y = float(hips[1] / frame_h) if hips is not None else None

    head_below = None
    if hips is not None and kpts[NOSE, 2] >= min_conf:
        head_below = bool(kpts[NOSE, 1] > hips[1])

    return PoseFeatures(angle, aspect, hip_y, head_below, _legs_upright(kpts, min_conf),
                        visible, lower is not None, at_edge, source)


# ================================================================================================
# 2. Rules classifier (Stage A): upright, falling, lying or unclear
# ================================================================================================
#
# Stage A fall classifier: hand-tuned rules over pose features.
#
# Works without training data. Stage B (a learned model over keypoint sequences)
# should expose the same classify() signature so it can replace this class.

UPRIGHT = "upright"
FALLING = "falling"
LYING = "lying"
UNCLEAR = "unclear"  # too little of the person is visible to tell; doesn't move an incident either way


@dataclass(slots=True)
class RuleThresholds:
    lying_torso_angle_deg: float = 60.0
    falling_torso_angle_deg: float = 35.0
    lying_aspect_ratio: float = 1.3
    fall_velocity: float = 1.2  # hip drop speed, in the person's torso lengths per second
    standing_legs: float = 0.6  # legs_upright at or above this = on their feet, so not lying
    min_visible_keypoints: int = 6  # fewer than this = unclear


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


class RuleClassifier:
    name = "rules"
    version = "0.2.0"

    def __init__(self, thresholds: RuleThresholds):
        self.t = thresholds

    def classify(self, f: PoseFeatures, hip_velocity: float | None) -> tuple[str, float]:
        """Return (label, confidence) for one pose. hip_velocity > 0 means moving down."""
        t = self.t
        # Too few points, or no hips/legs at all (e.g. sitting behind a table): the box shape
        # alone is not evidence of lying, so say nothing rather than guess.
        if f.visible < t.min_visible_keypoints or not f.lower_body or f.torso_angle_deg is None:
            return UNCLEAR, 0.0

        lying_score = _clamp((f.torso_angle_deg - 30.0) / (t.lying_torso_angle_deg - 30.0))
        # A box cut off by the frame edge has the wrong shape: then trust the body angle only.
        if not f.at_edge:
            aspect_score = _clamp((f.aspect_ratio - 0.8) / (t.lying_aspect_ratio - 0.8))
            lying_score = 0.7 * lying_score + 0.3 * aspect_score
        if f.head_below_hips:
            lying_score = _clamp(lying_score + 0.15)
        # Ankles well below the hips on straight legs: standing or bent over, not lying,
        # however tilted the upper body is.
        if f.legs_upright is not None and f.legs_upright >= t.standing_legs:
            lying_score = min(lying_score, 0.5)

        if lying_score >= 0.75:
            return LYING, lying_score

        if (
            hip_velocity is not None
            and hip_velocity >= t.fall_velocity
            and f.torso_angle_deg is not None
            and f.torso_angle_deg >= t.falling_torso_angle_deg
        ):
            return FALLING, _clamp(0.5 + hip_velocity / (2 * t.fall_velocity) * 0.5)

        return UPRIGHT, 1.0 - lying_score


# ================================================================================================
# 3. Learned classifier (Stage B): a small trained model
# ================================================================================================
#
# Stage B fall classifier: a small learned model over the last second of a person's body points.
#
# The rules (app/detection/fall_detection.py) measure angles in the picture, which fails for high ceiling
# cameras: someone lying along the camera's line of sight looks upright. This model learns from
# examples instead (model_finetuning/finetune.py, Multiple Cameras Fall Dataset), using where the body
# points are inside the person's box, the box's size and place in the picture, and how they
# changed over the last second.
#
# It runs in NumPy (no PyTorch needed at run time). The model file is a .npz with the layer
# weights, the input scaling and the decision threshold.

WINDOW = 10            # frames of history (1 s at the default 10 fps)
FRAME_DIM = 17 * 3 + 5


def frame_vector(box: np.ndarray, kpts: np.ndarray, frame_shape: tuple[int, ...], min_conf: float) -> np.ndarray:
    """One person in one frame as numbers: body points relative to their box, and the box itself."""
    h, w = frame_shape[:2]
    x1, y1, x2, y2 = (float(v) for v in box)
    bw, bh = max(x2 - x1, 1.0), max(y2 - y1, 1.0)
    size, cx, cy = max(bw, bh), (x1 + x2) / 2, (y1 + y2) / 2
    seen = kpts[:, 2] >= min_conf
    pts = np.zeros((17, 3), dtype=np.float32)
    pts[seen, 0] = (kpts[seen, 0] - cx) / size
    pts[seen, 1] = (kpts[seen, 1] - cy) / size
    pts[:, 2] = seen
    box_f = [np.log(bw / bh), bh / h, bw / w, cy / h, cx / w]
    return np.concatenate([pts.ravel(), np.asarray(box_f, dtype=np.float32)])


def window_vector(history: deque | list) -> np.ndarray:
    """Now, the average over the window, and the change since the start of the window."""
    frames = np.stack(list(history))
    now = frames[-1]
    return np.concatenate([now, frames.mean(axis=0), now - frames[0]])


class LearnedClassifier:
    name = "learned"

    def __init__(self, path: str | Path):
        m = np.load(path)
        self.layers = [(m[f"w{i}"], m[f"b{i}"]) for i in range(int(m["n_layers"]))]
        self.mean, self.std = m["mean"], m["std"]
        self.threshold = float(m["threshold"])
        self.version = str(m["version"])

    def probability(self, history: deque | list) -> float:
        """Probability that the person is down (falling or lying on the floor) now."""
        x = (window_vector(history) - self.mean) / self.std
        for i, (w, b) in enumerate(self.layers):
            x = x @ w + b
            if i < len(self.layers) - 1:
                x = np.maximum(x, 0.0)
        return float(1.0 / (1.0 + np.exp(-x[0])))


# ================================================================================================
# 4. Incident timing: from per-frame labels to fall incidents
# ================================================================================================
#
# Turns per-frame labels into fall incidents for each tracked person.
#
# An incident opens when a person has been down (falling or lying) for confirm_seconds
# AND at least confirm_ratio of their frames in that time were down; it closes when they
# stay up for recover_seconds. The ratio check stops a few stray "lying" frames, seconds
# apart, from adding up to an alarm.

STARTED = "incident_started"
UPDATED = "incident_updated"
RECOVERED = "incident_recovered"
UNRESOLVED = "incident_unresolved"


@dataclass(slots=True)
class MonitorConfig:
    confirm_seconds: float = 3.0
    confirm_ratio: float = 0.8   # share of frames in the last confirm_seconds that must be down
    recover_seconds: float = 3.0
    lost_track_seconds: float = 10.0
    high_after_seconds: float = 60.0
    critical_after_seconds: float = 300.0


@dataclass(slots=True)
class Incident:
    track_id: int
    started_at: float
    peak_confidence: float
    severity: str = "medium"
    recovered_at: float | None = None


@dataclass(slots=True)
class IncidentEvent:
    kind: str
    incident: Incident
    at: float


@dataclass(slots=True)
class _Track:
    last_seen: float
    recent: deque = field(default_factory=deque)  # (time, is_down) over the last 2 x confirm_seconds
    down_since: float | None = None
    up_since: float | None = None
    incident: Incident | None = None


class FallMonitor:
    def __init__(self, cfg: MonitorConfig):
        self.cfg = cfg
        self._tracks: dict[int, _Track] = {}

    def update(self, t: float, track_id: int, label: str, confidence: float) -> list[IncidentEvent]:
        track = self._tracks.setdefault(track_id, _Track(last_seen=t))
        track.last_seen = t
        events: list[IncidentEvent] = []
        if label == UNCLEAR:  # no evidence either way: keep the person, change nothing
            return events
        down = label in (FALLING, LYING)
        track.recent.append((t, down))
        while track.recent[0][0] < t - 2 * self.cfg.confirm_seconds:
            track.recent.popleft()

        if down:
            track.up_since = None
            if track.down_since is None:
                track.down_since = t
            if track.incident is None and label == LYING and self._confirmed(track, t):
                track.incident = Incident(track_id, self._run_start(track), confidence)
                events.append(IncidentEvent(STARTED, track.incident, t))
            elif track.incident is not None:
                track.incident.peak_confidence = max(track.incident.peak_confidence, confidence)

        elif label == UPRIGHT:
            if track.up_since is None:
                track.up_since = t
            if t - track.up_since >= self.cfg.recover_seconds:
                track.down_since = None
                if track.incident is not None:
                    track.incident.recovered_at = track.up_since
                    events.append(IncidentEvent(RECOVERED, track.incident, t))
                    track.incident = None

        if track.incident is not None:
            severity = self._severity(t - track.incident.started_at)
            if severity != track.incident.severity:
                track.incident.severity = severity
                events.append(IncidentEvent(UPDATED, track.incident, t))

        return events

    def _confirmed(self, track: _Track, t: float) -> bool:
        if t - track.down_since < self.cfg.confirm_seconds:
            return False
        window = [d for ts, d in track.recent if ts >= t - self.cfg.confirm_seconds]
        return len(window) >= 3 and sum(window) >= self.cfg.confirm_ratio * len(window)

    def _run_start(self, track: _Track) -> float:
        """When the person went down: the earliest down frame from which on they were down for
        at least confirm_ratio of the frames. A stray frame long before the fall is skipped."""
        start, down, n = track.recent[-1][0], 0, 0
        for ts, d in reversed(track.recent):
            n += 1
            down += d
            if d and down >= self.cfg.confirm_ratio * n:
                start = ts
        return max(start, track.down_since)

    def expire(self, t: float) -> list[IncidentEvent]:
        """Drop tracks not seen recently. An open incident on a lost track becomes unresolved."""
        events: list[IncidentEvent] = []
        for track_id, track in list(self._tracks.items()):
            if t - track.last_seen < self.cfg.lost_track_seconds:
                continue
            if track.incident is not None:
                events.append(IncidentEvent(UNRESOLVED, track.incident, t))
            del self._tracks[track_id]
        return events

    def rename(self, old_id: int, new_id: int) -> None:
        """The tracker renumbered a person: carry their state (and any open incident) over."""
        if old_id in self._tracks:
            self._tracks[new_id] = self._tracks.pop(old_id)

    def has_track(self, track_id: int) -> bool:
        return track_id in self._tracks

    def incident_of(self, track_id: int) -> Incident | None:
        track = self._tracks.get(track_id)
        return track.incident if track is not None else None

    def close_all(self, t: float) -> list[IncidentEvent]:
        """The camera went away: every open incident becomes unresolved and all tracks are dropped."""
        events = [IncidentEvent(UNRESOLVED, track.incident, t)
                  for track in self._tracks.values() if track.incident is not None]
        self._tracks.clear()
        return events

    def _severity(self, down_for: float) -> str:
        if down_for >= self.cfg.critical_after_seconds:
            return "critical"
        if down_for >= self.cfg.high_after_seconds:
            return "high"
        return "medium"


# ================================================================================================
# 5. FallDetector: steps 1-4 for every person one camera sees
# ================================================================================================
#
# Fall detection for one camera: tracked poses in, labels and incident events out.
#
# app/camera_service/camera_pipeline.py uses this for live cameras and evaluation/evaluate.py for the benchmark, so both
# run exactly the same logic.

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
    # "rules" (app/detection/fall_detection.py, picture angles) or "learned" (app/detection/fall_detection.py, trained model).
    classifier: str = "rules"
    learned_model: str = "models/stage_b.npz"
    learned_min_keypoints: int = 3   # with fewer visible points the learned model says "unclear"


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
    window: deque = field(default_factory=lambda: deque(maxlen=WINDOW))  # learned classifier input


class FallDetector:
    """Keeps per-person state between frames, so create one instance per camera."""

    def __init__(self, rules: RuleThresholds, monitor: MonitorConfig, cfg: DetectorConfig | None = None):
        self.cfg = cfg or DetectorConfig()
        self.rules = RuleClassifier(rules)
        if self.cfg.classifier == "learned":
            self.learned: LearnedClassifier | None = LearnedClassifier(self.cfg.learned_model)
            self.classifier = self.learned  # name/version recorded with every prediction
        elif self.cfg.classifier == "rules":
            self.learned = None
            self.classifier = self.rules
        else:
            raise ValueError(f"fall.classifier must be rules or learned, got {self.cfg.classifier!r}")
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
            label, confidence = self.rules.classify(features, velocity)
            if self.learned is not None:
                label, confidence = self._learned_label(person, track, features, frame_shape, label)
            results.append(PersonResult(person.track_id, label, confidence, features, velocity))
            events += self.monitor.update(t, person.track_id, label, confidence)
        return results, events

    def _learned_label(self, person: TrackedPose, track: _PoseTrack, features: PoseFeatures,
                       frame_shape: tuple[int, ...], rules_label: str) -> tuple[str, float]:
        """The learned model decides down or not; the rules still supply 'falling' while going down."""
        track.window.append(frame_vector(person.box, person.keypoints, frame_shape, self.cfg.min_keypoint_conf))
        if features.visible < self.cfg.learned_min_keypoints:
            return UNCLEAR, 0.0
        p = self.learned.probability(track.window)
        if p >= self.learned.threshold:
            return LYING, p
        return (FALLING if rules_label == FALLING else UPRIGHT), 1.0 - p

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
