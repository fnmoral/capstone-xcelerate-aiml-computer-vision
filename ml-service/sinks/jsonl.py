"""Writes predictions and incidents to local JSON Lines files (data/*.jsonl)."""

import json
import threading
from datetime import datetime
from pathlib import Path


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

    def close(self) -> None:
        pass
