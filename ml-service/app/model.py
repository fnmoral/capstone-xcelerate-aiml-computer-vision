"""Loading the pose model and picking where it runs."""

import logging
import os
import sys
import time
from pathlib import Path

import numpy as np

import config
from vision.pose import PoseTracker, describe_device

log = logging.getLogger("ml-service")


def warm_up(cfg: config.Config) -> str:
    """Load the model and run it once, so CUDA start-up (several seconds) happens
    before cameras open. Returns what inference.device resolved to, e.g. "GPU 0 (NVIDIA ...)".
    """
    inf = cfg.inference
    start = time.perf_counter()
    tracker = PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half)
    tracker(np.zeros((inf.imgsz, inf.imgsz, 3), dtype=np.uint8))
    device_in_use = describe_device(tracker.device) + (" FP16" if tracker.half else "")
    log.info("model %s ready on %s%s in %.1fs", Path(inf.weights).name, describe_device(tracker.device),
             " (FP16)" if tracker.half else "", time.perf_counter() - start)
    return device_in_use


def has_display() -> bool:
    if sys.platform != "linux":
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))