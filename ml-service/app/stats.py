"""Periodic reporting: the stats log line, the database status row, and the
Detection Settings payload they're both built from.
"""

import logging
import threading
import time
from pathlib import Path

from app.detection.pose_model import available_devices, available_models
from app.runtime import Runtime

log = logging.getLogger("ml-service")

STATUS_EVERY_S = 10.0       # how often the Detection Settings figures are written to the database
MIN_STATS_WINDOW_S = 10.0   # don't judge a camera on its first few seconds (model start-up)


def log_stats(pipelines: list, target_fps: float) -> None:
    """One line per camera: frames received and analysed per second, and average model time."""
    parts = []
    behind = []
    for p in pipelines:
        frames_in, analysed, model_ms, seconds = p.take_stats()
        fps = analysed / seconds
        avg_ms = model_ms / analysed if analysed else 0.0
        parts.append(f"{p.camera_id} in={frames_in / seconds:.1f}fps analysed={fps:.1f}fps model={avg_ms:.0f}ms")
        # Sources slower than target_fps can't reach it; only flag cameras that have frames to spare.
        if seconds >= MIN_STATS_WINDOW_S and frames_in / seconds >= target_fps and fps < 0.8 * target_fps:
            behind.append(p.camera_id)
    log.info("stats: %d camera(s) | %s", len(pipelines), " | ".join(parts) or "none connected")
    if behind:
        log.warning("analysing fewer than %.0f fps on %s; the GPU is saturated. Lower inference.target_fps "
                    "or use a faster GPU/model", target_fps, ", ".join(behind))


def report_status(runtime: Runtime, pg, stop: threading.Event) -> None:
    """Write what this service runs and how fast (detection_settings) to the database,
    where the backend reads it for the Detection Settings page."""
    while True:
        pg.status(detection_settings(runtime))
        if stop.wait(STATUS_EVERY_S):
            return


def detection_settings(runtime: Runtime) -> dict:
    """Read-only summary of the detection settings, shown by the frontend (via ml_status)."""
    cfg = runtime.cfg
    r, m = cfg.rules, cfg.monitor
    cameras = []
    now = time.time()
    items = runtime.active_items()
    for camera_id, p in items:
        received, analysed = p.rates()
        cameras.append({
            "camera_id": camera_id,
            "received_fps": round(received, 1),
            "analysed_fps": round(analysed, 1),
            # The backend uses this for camera health ("not working" after 20 s without video).
            "last_frame_age_s": round(now - p.latest_at, 1) if p.latest_at else None,
            "model": getattr(p, "model_file", None),
            "device_in_use": getattr(p, "device_in_use", "") or None,
        })
    live = [c["analysed_fps"] for c in cameras if c["received_fps"] > 0]
    # What the cameras run now (the model can be changed in the frontend); before any camera
    # has run the model, config.yaml's model and the device found at start-up.
    running = [c for c in cameras if c["device_in_use"]]
    errors = sorted({e for _, p in items if (e := getattr(p, "inference_error", None))})
    models_dir = Path(cfg.inference.weights).parent
    return {
        "mode": "prod" if cfg.prod_mode else "dev",
        "model": running[0]["model"] if running else Path(cfg.inference.weights).name,
        "model_default": Path(cfg.inference.weights).name,  # config.yaml
        "models_available": available_models(models_dir),
        "device": str(cfg.inference.device),  # as configured ("auto", 0, "cpu")
        "device_in_use": (running[0]["device_in_use"] if running else runtime.device_in_use) or None,
        "devices_available": available_devices(),
        "inference_error": "; ".join(errors) or None,  # a model/device chosen in the frontend that failed
        "analysis": {  # measured over the last 30 s
            "average_fps": round(sum(live) / len(live), 1) if live else None,
            "cameras": cameras,
        },
        "target_fps": cfg.inference.target_fps,
        "person_confidence": runtime.tenant_overrides(cfg.default_tenant_id).get(
            "person_confidence", cfg.inference.conf),
        "person_confidence_default": cfg.inference.conf,  # config.yaml; the frontend can override it
        "rules": {
            "lying_torso_angle_deg": r.lying_torso_angle_deg,
            "falling_torso_angle_deg": r.falling_torso_angle_deg,
            "lying_aspect_ratio": r.lying_aspect_ratio,
            "fall_velocity": r.fall_velocity,
            "standing_legs": r.standing_legs,
            "min_visible_keypoints": r.min_visible_keypoints,
            "confirm_ratio": m.confirm_ratio,
            "min_keypoint_conf": cfg.detector.min_keypoint_conf,
        },
        "incidents": {
            "confirm_seconds": m.confirm_seconds,
            "recover_seconds": m.recover_seconds,
            "handoff_seconds": cfg.detector.handoff_seconds,
            "lost_track_seconds": m.lost_track_seconds,
            "high_after_seconds": m.high_after_seconds,
            "critical_after_seconds": m.critical_after_seconds,
            "merge_window_seconds": cfg.merge_window_s,
        },
        "zones": {name: cams for name, cams in runtime.aggregator.zones().items()},
    }