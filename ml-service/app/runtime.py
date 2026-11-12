"""The service's shared state: connected cameras, the zone aggregator, and the
detection-setting overrides the frontend can change. One instance per process,
built once in main() and passed to whatever needs it, instead of module globals.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

from app import config
from app.camera_service.camera_pipeline import IncidentAggregator
from app.camera_service.hub_results import Publish
from app.camera_service.results import FanoutSink, SnapshotStore

if TYPE_CHECKING:
    from app.camera_service.camera_pipeline import CameraPipeline

log = logging.getLogger("ml-service")


class Runtime:
    """Not thread-safe by convention but safe in practice: `pipelines` and
    `overrides` are only ever mutated through the methods below, each of which
    takes its own lock or relies on an atomic dict rebind.
    """

    def __init__(self, cfg: config.Config, sink: FanoutSink, aggregator: IncidentAggregator,
                 snapshots: SnapshotStore):
        self.cfg = cfg
        self.sink = sink
        self.aggregator = aggregator
        self.snapshots = snapshots
        # What inference.device resolved to, e.g. "GPU 0 (NVIDIA ...)"; set by app.model.warm_up.
        self.device_in_use = ""
        # Changed in the frontend, per tenant (slug and UUID); see app.db.load_overrides.
        # Reassigned as a whole dict, never mutated in place, so reading it without a lock
        # always sees a complete (if possibly stale) snapshot.
        self.overrides: dict[str, dict] = {}

        self._lock = threading.Lock()
        self._pipelines: dict[str, CameraPipeline] = {}

    def tenant_overrides(self, tenant_id: str) -> dict:
        return self.overrides.get(tenant_id, {})

    def new_pipeline(self, tenant_id: str, camera_id: str, publish: Publish | None = None) -> "CameraPipeline":
        from app.camera_service.camera_pipeline import CameraPipeline  # deferred: pulls in the pose model's dependencies

        return CameraPipeline(tenant_id, camera_id, self.cfg, self.sink, self.aggregator, self.snapshots,
                              overrides=self.tenant_overrides, publish=publish)

    def register(self, pipeline: "CameraPipeline") -> bool:
        with self._lock:
            if pipeline.camera_id in self._pipelines:
                log.error("camera [%s] is already connected; ignoring the second one", pipeline.camera_id)
                return False
            self._pipelines[pipeline.camera_id] = pipeline
            return True

    def unregister(self, pipeline: "CameraPipeline") -> None:
        with self._lock:
            if self._pipelines.get(pipeline.camera_id) is not pipeline:
                return
            del self._pipelines[pipeline.camera_id]
        pipeline.close()  # open incidents on this camera become unresolved

    def active_pipelines(self) -> list["CameraPipeline"]:
        with self._lock:
            return list(self._pipelines.values())

    def active_items(self) -> list[tuple[str, "CameraPipeline"]]:
        with self._lock:
            return list(self._pipelines.items())