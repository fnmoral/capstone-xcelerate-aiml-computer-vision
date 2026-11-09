"""Turns per-frame labels into fall incidents for each tracked person.

An incident opens when a person has been down (falling or lying) for confirm_seconds
AND at least confirm_ratio of their frames in that time were down; it closes when they
stay up for recover_seconds. The ratio check stops a few stray "lying" frames, seconds
apart, from adding up to an alarm.
"""

from collections import deque
from dataclasses import dataclass, field

from fall.rules import FALLING, LYING, UNCLEAR, UPRIGHT

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
