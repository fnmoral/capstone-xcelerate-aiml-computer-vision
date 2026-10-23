"""Writes predictions and incidents to local JSON Lines files.

Field names match the incidents and model_predictions tables in
backend-module/db/schema.sql, so a backend sink can send the same records.
Incidents are zone-level (see fall/zones.py): `camera_id` is the first camera that saw
the fall, and `camera_ids` lists every camera that did. The schema has no table for the
extra cameras yet.
"""

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from fall.zones import ZoneIncident


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, UTC).isoformat() if ts is not None else None


class JsonlSink:
    def __init__(self, out_dir: str):
        self.dir = Path(out_dir)
        (self.dir / "snapshots").mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

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

    def incident(self, kind: str, inc: ZoneIncident, snapshot: np.ndarray | None,
                 snapshot_camera: str | None = None) -> None:
        snapshot_key = None
        if snapshot is not None:
            name = inc.id if snapshot_camera in (None, inc.camera_id) else f"{inc.id}_{snapshot_camera}"
            snapshot_key = f"snapshots/{name}.jpg"
            cv2.imwrite(str(self.dir / snapshot_key), snapshot)

        self._append("incidents.jsonl", {
            "event": kind,
            "id": inc.id,
            "tenant_id": inc.tenant_id,
            "camera_id": inc.camera_id,
            "camera_ids": list(inc.cameras),
            "zone": inc.zone,
            "incident_type": "fall",
            "started_at": _iso(inc.started_at),
            "recovered_at": _iso(inc.recovered_at),
            "status": inc.status,
            "severity": inc.severity,
            "peak_confidence": round(inc.peak_confidence, 4),
            "snapshot_key": snapshot_key,
            "tracks": list(inc.tracks),
        })
