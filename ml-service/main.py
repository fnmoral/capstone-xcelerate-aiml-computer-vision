"""ML service entry point: detects falls in camera video.

config.yaml has a dev and a prod section; `prod_mode` picks one (see CONFIG.md). In dev,
stream-hub (tcp), webcams, RTSP cameras and video files all go through the same pipeline.
Prod accepts IP cameras only (tcp, rtsp). Flags override the file for a quick test:

    python main.py                                  # use config.yaml
    python main.py --prod / --dev                   # force a mode
    python main.py --webcam 0                       # this PC's first webcam
    python main.py --webcam 0 --tcp                 # a webcam next to the stream-hub cameras
    python main.py --rtsp rtsp://user:pw@cam/stream # an IP camera, without the Go services
    python main.py --video fall.mp4                 # a local video file
    python main.py --show / --no-show               # force the preview window on or off

A mode flag (--prod/--dev) and a source flag can't fight: --prod with --webcam/--video
is rejected, since production only watches IP cameras. Any --webcam/--rtsp/--video/--tcp
flag replaces config.yaml's source list for this run; without one, the file's list is used
as-is. Flags can repeat and combine (e.g. --webcam 0 --rtsp rtsp://cam1 --rtsp rtsp://cam2).

Environment: ML_CONFIG picks the config file, ML_PROD_MODE=true forces prod (the container sets both).
"""

import logging
import os
import sys
import threading

import cv2

from app.camera_service.camera_pipeline import IncidentAggregator
from app.camera_service.results import SnapshotStore
from app.cli import build_config
from app.db import build_sink, load_db_zones, load_overrides, merge_zones, refresh_from_db
from app.loop import main_loop
from app.model import has_display, warm_up
from app.runtime import Runtime
from app.sources import run_capture
from app.stats import report_status
from app.stream_hub import start as start_stream_hub

log = logging.getLogger("ml-service")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Prefer TCP for RTSP: UDP drops packets on busy networks, which corrupts frames.
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

    try:
        cfg = build_config()
    except ValueError as e:
        log.error("config error: %s", e)
        sys.exit(2)

    log.info("mode: %s, sources: %s", "PROD (IP cameras only)" if cfg.prod_mode else "DEV",
             ", ".join(s.type if s.type == "tcp" else f"{s.type}:{s.camera_id}" for s in cfg.sources))
    if cfg.show and not has_display():
        log.warning("no display found; preview turned off")
        cfg.show = False

    sink, pg = build_sink(cfg)
    db_zones = (load_db_zones(pg) or {}) if pg is not None and cfg.zones_from_db else {}
    zones = merge_zones(cfg.zones, db_zones)
    aggregator = IncidentAggregator(zones, cfg.merge_window_s)
    snapshots = SnapshotStore(cfg.output_dir)  # only used by sources read directly (dev)
    runtime = Runtime(cfg, sink, aggregator, snapshots)
    if pg is not None:
        load_overrides(pg, runtime)
    for name, cams in zones.items():
        log.info("zone [%s]: %s (falls seen by several of these cameras count once)", name, ", ".join(cams))

    stop = threading.Event()
    if pg is not None:
        threading.Thread(target=refresh_from_db, args=(cfg, pg, runtime, stop), name="db-refresh",
                         daemon=True).start()

    runtime.device_in_use = warm_up(cfg)
    if pg is not None:  # after warm_up, so the first status already says which device is in use
        threading.Thread(target=report_status, args=(runtime, pg, stop), name="status", daemon=True).start()

    server = start_stream_hub(cfg, runtime) if cfg.uses_tcp else None
    capture_threads = []
    for src in cfg.sources:
        if src.type != "tcp":
            thread = threading.Thread(target=run_capture, args=(src, runtime, stop), daemon=True,
                                      name=f"capture-{src.camera_id}")
            thread.start()
            capture_threads.append(thread)

    try:
        main_loop(stop, cfg.show, capture_threads, cfg.uses_tcp, cfg.stats_interval_s, cfg.inference.target_fps,
                 runtime)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if server is not None:
            server.close()
        if cfg.show:
            cv2.destroyAllWindows()
        sink.close()  # lets the database writer finish what is queued
        log.info("stopped")


if __name__ == "__main__":
    main()