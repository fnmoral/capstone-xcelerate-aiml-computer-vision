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
    sys.path.append(str(Path(__file__).resolve().parent / "lap_compat"))

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


def available_devices() -> list[dict]:
    """Devices that can be picked in Detection Settings: auto, the CPU and each GPU."""
    devices = [{"value": "auto", "label": "Auto (GPU if available)"}, {"value": "cpu", "label": "CPU"}]
    if torch.cuda.is_available():
        devices += [{"value": str(i), "label": f"GPU {i} ({torch.cuda.get_device_name(i)})"}
                    for i in range(torch.cuda.device_count())]
    return devices


def available_models(models_dir: Path) -> list[str]:
    """Pose model files in models_dir that can be picked in Detection Settings. Only pose
    models work here: the fall rules need the body points."""
    if not models_dir.is_dir():
        return []
    return sorted(p.name for p in models_dir.glob("*.pt") if "pose" in p.name.lower())


def parse_device(value: str | int) -> str | int:
    """"0" -> 0 (a GPU index), anything else as is ("auto", "cpu")."""
    return int(value) if str(value).isdigit() else value


DUPLICATE_OVERLAP = 0.8  # a box this much inside a stronger one is the same person


def drop_duplicates(xyxy: np.ndarray, confs: np.ndarray, indexes: list[int]) -> list[int]:
    """The indexes without duplicate boxes of one person: a box lying at least
    DUPLICATE_OVERLAP inside a stronger box (or a stronger box inside it) is dropped.

    The pose model sometimes adds a partial box (upper body only) or a box spanning two people
    lying close together; each would get its own track and open a second incident for the same
    person. Two different people overlap far less than this (e.g. someone standing over a person
    on the floor).
    """
    kept: list[int] = []
    for i in sorted(indexes, key=lambda k: -float(confs[k])):
        x1, y1, x2, y2 = xyxy[i]
        area = max(x2 - x1, 0.0) * max(y2 - y1, 0.0)
        duplicate = False
        for j in kept:
            a1, b1, a2, b2 = xyxy[j]
            inter = max(min(x2, a2) - max(x1, a1), 0.0) * max(min(y2, b2) - max(y1, b1), 0.0)
            smaller = min(area, max(a2 - a1, 0.0) * max(b2 - b1, 0.0))
            if smaller > 0 and inter / smaller >= DUPLICATE_OVERLAP:
                duplicate = True
                break
        if not duplicate:
            kept.append(i)
    return sorted(kept)


@dataclass(slots=True)
class Person:
    track_id: int
    box: np.ndarray        # (4,) x1, y1, x2, y2 in pixels
    confidence: float
    keypoints: np.ndarray  # (17, 3) x, y, confidence in COCO order


class PoseTracker:
    """Detects people, their 17 COCO keypoints and a stable track ID.

    The tracker keeps state between calls, so create one instance per camera.

    Two confidence levels: a person is reported once their detection reaches `conf`, and
    after that they stay tracked down to `track_conf`. People lying on the floor often get
    lower scores than people standing (the model saw fewer of them in training), so a single
    threshold would lose someone exactly when they fall.
    """

    FORGET_AFTER_FRAMES = 300  # drop a confirmed ID not seen for this many calls

    def __init__(self, weights: str, device: str | int, conf: float, imgsz: int, tracker: str,
                 half: bool = False, track_conf: float = 0.1):
        self.model = YOLO(weights)
        if self.model.task != "pose":
            raise ValueError(f"{Path(weights).name} is a {self.model.task} model; a pose model is needed")
        self.weights = str(weights)
        self.device = resolve_device(parse_device(device))
        self.half = half and self.device != "cpu"  # FP16 is GPU-only
        self.conf = conf
        self.track_conf = track_conf
        self.imgsz = imgsz
        self.tracker = tracker
        self._frame = 0
        self._confirmed: dict[int, int] = {}  # track ID -> frame it was last seen

    @classmethod
    def from_config(cls, inf) -> "PoseTracker":
        """Build from config.InferenceConfig."""
        return cls(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half, inf.track_conf)

    def __call__(self, frame: np.ndarray) -> list[Person]:
        # Ultralytics 8.4 replaced the `half` argument with `quantize` (16 = FP16).
        precision = {"quantize": 16} if self.half else {}
        result = self.model.track(
            frame,
            persist=True,
            tracker=self.tracker,
            conf=min(self.track_conf, self.conf),  # weak detections go to the tracker too
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
        keep = drop_duplicates(xyxy, confs, self._keep(ids, confs))
        return [Person(int(ids[i]), xyxy[i], float(confs[i]), kpts[i]) for i in keep]

    def _keep(self, ids: np.ndarray, confs: np.ndarray) -> list[int]:
        """Indexes of the people to report: those whose track has reached `conf` at least once."""
        self._frame += 1
        keep = []
        for i, (track_id, conf) in enumerate(zip(ids.tolist(), confs.tolist())):
            if conf >= self.conf or track_id in self._confirmed:
                self._confirmed[track_id] = self._frame
                keep.append(i)
        if self._frame % 100 == 0:
            cutoff = self._frame - self.FORGET_AFTER_FRAMES
            self._confirmed = {k: v for k, v in self._confirmed.items() if v >= cutoff}
        return keep
