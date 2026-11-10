"""Where results go: the shared record format, snapshots, and the JSONL files.

The PostgreSQL sink is in database.py (it needs psycopg, loaded only when the database is used).
"""

import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import cv2
import numpy as np

if TYPE_CHECKING:  # only for type hints: camera_pipeline imports this module
    from camera_service.camera_pipeline import ZoneIncident


# ================================================================================================
# 1. Record format, snapshots and the Sink interface
# ================================================================================================
#
# Where results go. Every sink receives the same records:
#
# - prediction records: one per person per `prediction_interval_s` (model_predictions table)
# - incident records: one per zone-level incident event (incidents, incident_cameras, alerts)
# - clip records: one per saved incident video clip, per camera (camera_service/clips.py)
#
# Field names follow backend-module/db/schema.sql. Timestamps are timezone-aware datetimes;
# each sink serialises them as it needs. Snapshots are saved once by SnapshotStore, and the
# records only carry the resulting key.

log = logging.getLogger(__name__)


class Sink(Protocol):
    def prediction(self, record: dict) -> None: ...
    def incident(self, record: dict) -> None: ...
    def clip(self, record: dict) -> None: ...
    def close(self) -> None: ...


def utc(ts: float | None) -> datetime | None:
    return datetime.fromtimestamp(ts, UTC) if ts is not None else None


def prediction_record(tenant_id: str, camera_id: str, at: float, model_name: str, model_version: str,
                      label: str, confidence: float, output: dict, inference_ms: int,
                      incident_id: str | None) -> dict:
    return {
        "tenant_id": tenant_id,
        "camera_id": camera_id,
        "incident_id": incident_id,          # zone incident this person is part of, if any
        "predicted_at": utc(at),
        "model_name": model_name,
        "model_version": model_version,
        "label": label,
        "confidence": round(confidence, 4),
        "output": output,
        "inference_ms": inference_ms,
    }


def incident_record(kind: str, inc: ZoneIncident, at: float, snapshot_key: str | None,
                    snapshot_camera: str | None) -> dict:
    return {
        "event": kind,
        "event_at": utc(at),
        "id": inc.id,
        "tenant_id": inc.tenant_id,
        "camera_id": inc.camera_id,          # first camera that confirmed the fall
        "camera_ids": list(inc.cameras),
        "zone": inc.zone if not inc.zone.startswith("camera:") else None,
        "incident_type": "fall",
        "started_at": utc(inc.started_at),
        "recovered_at": utc(inc.recovered_at),
        "status": inc.status,
        "severity": inc.severity,
        "peak_confidence": round(inc.peak_confidence, 4),
        "snapshot_key": snapshot_key,        # this event's image, if one was taken
        "snapshot_camera": snapshot_camera,
        "tracks": list(inc.tracks),          # "camera#track" per person
    }


def clip_record(tenant_id: str, incident_id: str, camera_id: str, key: str, seconds: float) -> dict:
    return {"tenant_id": tenant_id, "incident_id": incident_id, "camera_id": camera_id,
            "clip_key": key, "seconds": seconds}


class SnapshotStore:
    """Saves incident images under <output dir>/snapshots and returns their keys."""

    def __init__(self, out_dir: str):
        self.dir = Path(out_dir)
        (self.dir / "snapshots").mkdir(parents=True, exist_ok=True)

    def save(self, inc: ZoneIncident, camera_id: str, frame: np.ndarray) -> str:
        name = inc.id if camera_id == inc.camera_id else f"{inc.id}_{camera_id}"
        key = f"snapshots/{name}.jpg"
        cv2.imwrite(str(self.dir / key), frame)
        return key


class FanoutSink:
    """Sends every record to several sinks; one failing sink doesn't stop the others."""

    def __init__(self, sinks: list):
        self.sinks = sinks

    def _each(self, method: str, *args) -> None:
        for sink in self.sinks:
            try:
                getattr(sink, method)(*args)
            except Exception:
                log.exception("%s.%s failed", type(sink).__name__, method)

    def prediction(self, record: dict) -> None:
        self._each("prediction", record)

    def incident(self, record: dict) -> None:
        self._each("incident", record)

    def clip(self, record: dict) -> None:
        for sink in self.sinks:
            if hasattr(sink, "clip"):
                try:
                    sink.clip(record)
                except Exception:
                    log.exception("%s.clip failed", type(sink).__name__)

    def close(self) -> None:
        self._each("close")


# ================================================================================================
# 2. JSONL files: one line per prediction or incident
# ================================================================================================
#
# Writes predictions and incidents to local JSON Lines files (data/*.jsonl).

def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


class JsonlSink:
    def __init__(self, out_dir: str):
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _append(self, name: str, record: dict) -> None:
        line = json.dumps(record, ensure_ascii=False, default=_json_default)
        with self._lock, open(self.dir / name, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def prediction(self, record: dict) -> None:
        self._append("model_predictions.jsonl", record)

    def incident(self, record: dict) -> None:
        self._append("incidents.jsonl", record)

    def clip(self, record: dict) -> None:
        self._append("clips.jsonl", record)

    def close(self) -> None:
        pass
