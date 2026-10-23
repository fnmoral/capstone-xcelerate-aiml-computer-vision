"""Merges incidents from cameras that watch the same area, so one fall gives one alert.

Cameras are grouped into zones in config.yaml. Each camera's FallMonitor still tracks its
own people; this layer sits between the monitors and the sink. When a camera confirms a
fall in a zone that already has an open incident which started within merge_window_s, the
new one joins it instead of raising a second alert.

The merged incident:
- starts at the earliest member's start and lists every camera that saw it
- takes the highest severity and confidence of any member
- closes when every member has closed: `recovered` if any camera saw the person get up,
  otherwise `unresolved`

Only incidents from *different* cameras merge: two people falling on the same camera are
already told apart by that camera's tracker and stay separate incidents.

Limitation: two different people falling within the window, each seen by a *different*
camera of the same zone, are merged. Telling them apart needs cross-camera identity (a
shared floor plan), not built yet.
"""

import threading
import uuid
from dataclasses import dataclass, field

from fall.state_machine import RECOVERED, STARTED, UNRESOLVED, UPDATED, Incident, IncidentEvent

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

    def incident_id_for(self, inc: Incident | None) -> str | None:
        """ID of the zone incident a camera-level incident belongs to, if it is still open."""
        if inc is None:
            return None
        with self._lock:
            group = self._by_member.get(id(inc))
            return group.id if group is not None else None

    def zone_of(self, camera_id: str) -> str:
        # A camera without a zone is its own zone, so nothing is merged into it.
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
