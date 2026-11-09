"""The main loop: runs the model for every camera, in turn, on the main thread
(see pipeline.py's module docstring for why), plus the optional preview window.
"""

import logging
import threading
import time

import cv2
import numpy as np

from app.runtime import Runtime
from app.stats import log_stats

log = logging.getLogger("ml-service")


def render_grid(pipelines: list) -> np.ndarray:
    frames = [p.latest_annotated for p in pipelines if p.latest_annotated is not None]
    if not frames:
        blank = np.zeros((360, 640, 3), dtype=np.uint8)
        cv2.putText(blank, "Waiting for cameras...", (150, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (200, 200, 200), 2, cv2.LINE_AA)
        return blank
    frames = [cv2.resize(f, (640, 360)) for f in frames]
    cols = min(len(frames), 3)
    while len(frames) % cols:
        frames.append(np.zeros_like(frames[0]))
    return np.vstack([np.hstack(frames[i:i + cols]) for i in range(0, len(frames), cols)])


def main_loop(stop: threading.Event, show: bool, capture_threads: list[threading.Thread], uses_tcp: bool,
              stats_interval_s: float, target_fps: float, runtime: Runtime) -> None:
    """Runs the model for every camera, and the preview window. Both must stay on the main thread."""
    last_render = 0.0
    last_stats = time.monotonic()
    while not stop.is_set():
        if stats_interval_s > 0 and time.monotonic() - last_stats >= stats_interval_s:
            last_stats = time.monotonic()
            log_stats(runtime.active_pipelines(), target_fps)

        if not uses_tcp and not any(t.is_alive() for t in capture_threads):
            log.info("all sources have ended")
            return

        active = runtime.active_pipelines()
        ran = False
        for pipeline in active:
            try:
                ran |= pipeline.step()
            except Exception:
                log.exception("camera [%s] processing failed", pipeline.camera_id)

        now = time.monotonic()
        if show and (ran or now - last_render > 0.1):
            last_render = now
            cv2.imshow("ml-service", render_grid(active))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                stop.set()
        elif not ran:
            time.sleep(0.005)