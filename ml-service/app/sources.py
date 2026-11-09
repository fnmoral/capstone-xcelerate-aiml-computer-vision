"""Webcam, RTSP and video-file sources: read directly with OpenCV, outside the
stream-hub protocol. Each one becomes its own camera pipeline.

These cameras have no stream-hub connection to publish results on, so they get no
live detections on a frontend and no recorded clips; they are for prototyping and
for IP cameras read directly while stream-hub is down (see config.yaml).
"""

import logging
import sys
import time

import cv2

import config
from app.runtime import Runtime

log = logging.getLogger("ml-service")

RECONNECT_SECONDS = 3.0
RTSP_TIMEOUT_MS = 5000  # OpenCV's default is ~30 s, too slow to notice a dead camera


def open_capture(src: config.SourceConfig) -> cv2.VideoCapture:
    match src.type:
        case "webcam":
            # DirectShow opens Windows webcams much faster than the default backend.
            backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
            cap = cv2.VideoCapture(src.index, backend)
        case "rtsp":
            cap = cv2.VideoCapture(src.url, cv2.CAP_FFMPEG, [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_MS,
                cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_MS,
            ])
        case _:
            cap = cv2.VideoCapture(src.path)
    if src.type != "file":
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always process the newest frame
    return cap


def describe_source(src: config.SourceConfig) -> str:
    match src.type:
        case "webcam":
            return f"webcam {src.index}"
        case "rtsp":
            return src.url.split("@")[-1]  # hide credentials in logs
        case _:
            return src.path


def run_capture(src: config.SourceConfig, runtime: Runtime, stop) -> None:
    """Feeds one webcam, RTSP camera or video file into its pipeline.

    Webcams and RTSP cameras behave like stream-hub cameras: if they drop out, the camera
    disappears and is retried every few seconds. A file plays once, or loops.
    """
    label = describe_source(src)
    pipeline = runtime.new_pipeline(src.tenant_id, src.camera_id)
    if not runtime.register(pipeline):
        return

    looped = False
    try:
        while not stop.is_set():
            cap = open_capture(src)
            if not cap.isOpened():
                cap.release()
                if src.type == "file":
                    log.error("cannot open %s", label)
                    return
                log.warning("camera [%s] cannot open %s; retrying in %.0fs", src.camera_id, label, RECONNECT_SECONDS)
                stop.wait(RECONNECT_SECONDS)
                continue

            fps = cap.get(cv2.CAP_PROP_FPS)
            if fps <= 0:  # some webcam drivers report -1
                fps = 30.0
            if not looped:
                log.info("camera [%s] reading %s", src.camera_id, label)
            next_frame = time.monotonic()
            try:
                while not stop.is_set():
                    ok, frame = cap.read()
                    if not ok:
                        break
                    pipeline.submit(frame)
                    if src.type == "file":  # play files at real speed; live sources pace themselves
                        next_frame += 1 / fps
                        time.sleep(max(0.0, next_frame - time.monotonic()))
            finally:
                cap.release()

            if stop.is_set():
                return
            if src.type == "file":
                if not src.loop:
                    log.info("camera [%s] %s ended", src.camera_id, label)
                    return
                looped = True
                continue
            log.warning("camera [%s] lost %s; reconnecting in %.0fs", src.camera_id, label, RECONNECT_SECONDS)
            stop.wait(RECONNECT_SECONDS)
    finally:
        runtime.unregister(pipeline)