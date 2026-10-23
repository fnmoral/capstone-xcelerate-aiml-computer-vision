"""Writes predictions and incidents to local JSON Lines files.

Field names match the incidents and model_predictions tables in
backend-module/db/schema.sql, so a backend sink can send the same records.
"""

import json
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from fall.state_machine import RECOVERED, UNRESOLVED, IncidentEvent


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, UTC).isoformat() if ts is not None else None


class JsonlSink:
    def __init__(self, out_dir: str):
        self.dir = Path(out_dir)
        (self.dir / "snapshots").mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # (camera_id, track_id, started_at) -> incident UUID
        self._ids: dict[tuple[str, int, float], str] = {}

    def _append(self, name: str, record: dict) -> None:
        line = json.dumps(record, ensure_ascii=False)
        with self._lock, open(self.dir / name, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def prediction(self, tenant_id: str, camera_id: str, at: float, model_name: str,
                   model_version: str, label: str, confidence: float, output: dict,
                   inference_ms: int) -> None:
        self._append("model_predictions.jsonl", {
            "tenant_id": tenant_id,
            "camera_id": camera_id,
            "predicted_at": _iso(at),
            "model_name": model_name,
            "model_version": model_version,
            "label": label,
            "confidence": round(confidence, 4),
            "output": output,
            "inference_ms": inference_ms,
        })

    def incident(self, tenant_id: str, camera_id: str, event: IncidentEvent,
                 snapshot: np.ndarray | None) -> None:
        inc = event.incident
        key = (camera_id, inc.track_id, inc.started_at)
        incident_id = self._ids.setdefault(key, str(uuid.uuid4()))

        snapshot_key = None
        if snapshot is not None:
            snapshot_key = f"snapshots/{incident_id}.jpg"
            cv2.imwrite(str(self.dir / snapshot_key), snapshot)

        status = {RECOVERED: "recovered", UNRESOLVED: "unresolved"}.get(event.kind, "active")
        self._append("incidents.jsonl", {
            "event": event.kind,
            "id": incident_id,
            "tenant_id": tenant_id,
            "camera_id": camera_id,
            "incident_type": "fall",
            "started_at": _iso(inc.started_at),
            "recovered_at": _iso(inc.recovered_at),
            "status": status,
            "severity": inc.severity,
            "peak_confidence": round(inc.peak_confidence, 4),
            "snapshot_key": snapshot_key,
            "track_id": inc.track_id,
        })

        if event.kind in (RECOVERED, UNRESOLVED):
            self._ids.pop(key, None)
