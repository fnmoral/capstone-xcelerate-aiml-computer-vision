"""Wires hub_server.StreamHubServer to the runtime: each stream-hub connection
becomes one camera pipeline, with its results (detections, incident events, and
the recording/snapshot messages stream-hub acts on) published back on it.
"""

from app import config
from app.camera_service.hub_results import Publish
from app.camera_service.hub_server import StreamHubServer
from app.runtime import Runtime


def start(cfg: config.Config, runtime: Runtime) -> StreamHubServer:
    def open_camera(tenant_id: str, camera_id: str, publish: Publish):
        pipeline = runtime.new_pipeline(tenant_id, camera_id, publish)
        return pipeline if runtime.register(pipeline) else None

    server = StreamHubServer(cfg.host, cfg.port, cfg.tenant_in_handshake, cfg.default_tenant_id,
                             open_camera, runtime.unregister)
    server.start()
    return server