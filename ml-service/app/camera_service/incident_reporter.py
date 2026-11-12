"""Turns one camera's incident and zone events, and its per-frame detections, into
everything the outside world needs: sink records (for the database), the
recording start/stop commands and snapshots stream-hub acts on, and the live
messages a connected frontend sees. One instance per camera.

This is the only place that knows about *all* of those outputs together; nothing
else needs to know that a started incident also means "start recording a clip" or
"encode and send a snapshot".
"""
from __future__ import annotations

import logging

from typing import TYPE_CHECKING

import cv2
import numpy as np

from app.camera_service.hub_results import (Publish, detections_message, incident_message, person_entry,
                                            recording_message, snapshot_message)
from app.camera_service.results import (Sink, SnapshotStore, clip_key, clip_record, incident_record,
                                        prediction_record, snapshot_key, snapshot_name)
from app.detection.fall_detection import RECOVERED, STARTED, UNRESOLVED, IncidentEvent
from app.detection.pose_model import Person

if TYPE_CHECKING:  # only for type hints: camera_pipeline imports this module
    from app.camera_service.camera_pipeline import IncidentAggregator, ZoneIncident

log = logging.getLogger(__name__)

SNAPSHOT_JPEG_QUALITY = 85


class IncidentReporter:
    def __init__(self, tenant_id: str, camera_id: str, sink: Sink, aggregator: IncidentAggregator,
                 snapshots: SnapshotStore, publish: Publish | None):
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.sink = sink
        self.aggregator = aggregator
        self.snapshots = snapshots      # local snapshots, for sources without stream-hub
        self.publish = publish          # None for sources nobody watches live

    def report(self, event: IncidentEvent, frame: np.ndarray | None, pts: int | None = None) -> None:
        """A camera-level fall event (started, updated, recovered, unresolved)."""
        # Asked before handle(): once a member closes, the aggregator forgets it.
        incident_id = self.aggregator.incident_id_for(event.incident)
        reports = self.aggregator.handle(self.tenant_id, self.camera_id, event)
        # After handle(): a new incident only has an ID now.
        current_id = self.aggregator.incident_id_for(event.incident) or incident_id

        # Every camera that confirmed the fall records its own clip of it (in stream-hub).
        if event.kind == STARTED and current_id:
            self._publish(recording_message(self.camera_id, "start", current_id))
        elif event.kind in (RECOVERED, UNRESOLVED) and incident_id:
            self._publish(recording_message(self.camera_id, "stop", incident_id))
            if self.publish is not None:
                # stream-hub saves the clip post_roll_s from now under this key.
                self.sink.clip(clip_record(self.tenant_id, incident_id, self.camera_id,
                                           clip_key(incident_id, self.camera_id), None))

        for kind, zone_incident in reports:
            # Each camera that confirms the fall contributes its own snapshot.
            key = None
            if frame is not None and event.kind == STARTED:
                key = self._save_snapshot(zone_incident, frame)
            self.sink.incident(incident_record(kind, zone_incident, event.at, key, self.camera_id if key else None))
            self._publish(incident_message(self.camera_id, pts, kind, current_id, zone_incident.severity,
                                           zone_incident.zone, zone_incident.cameras))
            log.info("[%s] %s zone=%s cameras=%s severity=%s", self.camera_id, kind, zone_incident.zone,
                     ",".join(zone_incident.cameras), zone_incident.severity)

    def report_detections(self, pts: int, width: int, height: int, people: list[Person],
                          labels: dict[int, tuple[str, float]], incident_id_of) -> None:
        """Send who is where in this frame, also when nobody is (so the overlay clears).
        incident_id_of(track_id) looks up the open incident for one person, if any.
        """
        if self.publish is None:
            return
        entries = []
        for p in people:
            label, confidence = labels[p.track_id]
            entries.append(person_entry(p.track_id, label, confidence, p.box, width, height,
                                        incident_id_of(p.track_id), p.keypoints))
        self._publish(detections_message(self.camera_id, pts, width, height, entries))

    def report_prediction(self, tenant_id: str, at: float, model_name: str, model_version: str, label: str,
                          confidence: float, output: dict, inference_ms: int, incident_id: str | None) -> None:
        self.sink.prediction(prediction_record(tenant_id, self.camera_id, at, model_name, model_version, label,
                                               confidence, output, inference_ms, incident_id))

    def _save_snapshot(self, zone_incident: ZoneIncident, frame: np.ndarray) -> str | None:
        """Send this camera's snapshot to stream-hub (or save it locally for other sources)."""
        if self.publish is None:
            return self.snapshots.save(zone_incident, self.camera_id, frame)
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, SNAPSHOT_JPEG_QUALITY])
        if not ok:
            log.warning("[%s] could not encode the snapshot of incident %s", self.camera_id, zone_incident.id)
            return None
        name = snapshot_name(zone_incident, self.camera_id)
        self._publish(snapshot_message(self.camera_id, zone_incident.id, name, jpeg.tobytes()))
        return snapshot_key(name)

    def _publish(self, message: dict) -> None:
        if self.publish is None:
            return
        try:
            self.publish(message)
        except Exception:
            log.exception("[%s] could not publish a result", self.camera_id)