"""Person pose estimation and tracking with an Ultralytics YOLO26 pose model."""

import logging
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from ultralytics import YOLO

try:
    import lap  # noqa: F401  needed by ByteTrack
except ImportError:
    sys.path.append(str(Path(__file__).resolve().parents[1] / "compat"))

log = logging.getLogger(__name__)


def resolve_device(device: str | int) -> str | int:
    """Turn the config value into a device Ultralytics accepts.

    "auto" picks GPU 0 when CUDA is available, otherwise the CPU. A GPU index on a
    machine without CUDA falls back to the CPU instead of crashing.
    """
    if str(device).lower() == "auto":
        return 0 if torch.cuda.is_available() else "cpu"
    if str(device).lower() != "cpu" and not torch.cuda.is_available():
        log.warning("device %r requested but CUDA is not available; using CPU", device)
        return "cpu"
    return device


def describe_device(device: str | int) -> str:
    if device == "cpu":
        return "CPU"
    index = int(str(device).split(",")[0])
    return f"GPU {index} ({torch.cuda.get_device_name(index)})"


@dataclass(slots=True)
class Person:
    track_id: int
    box: np.ndarray        # (4,) x1, y1, x2, y2 in pixels
    confidence: float
    keypoints: np.ndarray  # (17, 3) x, y, confidence in COCO order


class PoseTracker:
    """Detects people, their 17 COCO keypoints and a stable track ID.

    The tracker keeps state between calls, so create one instance per camera.
    """

    def __init__(self, weights: str, device: str | int, conf: float, imgsz: int, tracker: str,
                 half: bool = False):
        self.model = YOLO(weights)
        self.device = resolve_device(device)
        self.half = half and self.device != "cpu"  # FP16 is GPU-only
        self.conf = conf
        self.imgsz = imgsz
        self.tracker = tracker

    def __call__(self, frame: np.ndarray) -> list[Person]:
        # Ultralytics 8.4 replaced the `half` argument with `quantize` (16 = FP16).
        precision = {"quantize": 16} if self.half else {}
        result = self.model.track(
            frame,
            persist=True,
            tracker=self.tracker,
            conf=self.conf,
            imgsz=self.imgsz,
            device=self.device,
            classes=[0],
            verbose=False,
            **precision,
        )[0]

        boxes = result.boxes
        if boxes is None or boxes.id is None or result.keypoints is None:
            return []

        ids = boxes.id.int().cpu().numpy()
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        kpts = result.keypoints.data.cpu().numpy()
        return [
            Person(int(ids[i]), xyxy[i], float(confs[i]), kpts[i])
            for i in range(len(ids))
        ]
