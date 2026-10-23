"""Turns per-frame labels into fall incidents for each tracked person.

A person must stay down for confirm_seconds before an incident opens, and stay
up for recover_seconds before it closes. This filters out bending, sitting down
and single-frame misdetections.
"""

from collections import deque
from dataclasses import dataclass, field

from fall.rules import FALLING, LYING, UPRIGHT

STARTED = "incident_started"
UPDATED = "incident_updated"
RECOVERED = "incident_recovered"
UNRESOLVED = "incident_unresolved"


@dataclass(slots=True)
class MonitorConfig:
    confirm_seconds: float = 3.0
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
    hip_history: deque = field(default_factory=lambda: deque(maxlen=8))
    down_since: float | None = None
    up_since: float | None = None
    incident: Incident | None = None


class FallMonitor:
    def __init__(self, cfg: MonitorConfig):
        self.cfg = cfg
        self._tracks: dict[int, _Track] = {}

    def hip_velocity(self, track_id: int, t: float, hip_y: float | None) -> float | None:
        """Record a hip position and return its downward speed in frame heights per second."""
        track = self._tracks.setdefault(track_id, _Track(last_seen=t))
        if hip_y is None:
            return None
        track.hip_history.append((t, hip_y))
        if len(track.hip_history) < 2:
            return None
        t0, y0 = track.hip_history[0]
        return (hip_y - y0) / (t - t0) if t > t0 else None

    def update(self, t: float, track_id: int, label: str, confidence: float) -> list[IncidentEvent]:
        track = self._tracks.setdefault(track_id, _Track(last_seen=t))
        track.last_seen = t
        events: list[IncidentEvent] = []

        if label in (FALLING, LYING):
            track.up_since = None
            if track.down_since is None:
                track.down_since = t
            if track.incident is None:
                if label == LYING and t - track.down_since >= self.cfg.confirm_seconds:
                    track.incident = Incident(track_id, track.down_since, confidence)
                    events.append(IncidentEvent(STARTED, track.incident, t))
            else:
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
