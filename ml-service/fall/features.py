"""Geometric features of a single pose, used by the fall rules."""

import math
from dataclasses import dataclass

import numpy as np

# COCO keypoint indices
NOSE = 0
L_SHOULDER, R_SHOULDER = 5, 6
L_HIP, R_HIP = 11, 12


@dataclass(slots=True)
class PoseFeatures:
    torso_angle_deg: float | None  # 0 = upright, 90 = horizontal
    aspect_ratio: float            # box width / height; > 1 means wider than tall
    hip_y: float | None            # hip height as a fraction of frame height (0 = top)
    head_below_hips: bool | None


def _midpoint(kpts: np.ndarray, a: int, b: int, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in (a, b) if kpts[i, 2] >= min_conf]
    if not pts:
        return None
    return np.mean(pts, axis=0)


def extract(box: np.ndarray, kpts: np.ndarray, frame_height: int, min_conf: float) -> PoseFeatures:
    x1, y1, x2, y2 = box
    aspect = float((x2 - x1) / max(y2 - y1, 1.0))

    shoulders = _midpoint(kpts, L_SHOULDER, R_SHOULDER, min_conf)
    hips = _midpoint(kpts, L_HIP, R_HIP, min_conf)

    angle = None
    if shoulders is not None and hips is not None:
        dx, dy = shoulders - hips
        angle = math.degrees(math.atan2(abs(dx), abs(dy)))

    hip_y = float(hips[1] / frame_height) if hips is not None else None

    head_below = None
    if hips is not None and kpts[NOSE, 2] >= min_conf:
        head_below = bool(kpts[NOSE, 1] > hips[1])

    return PoseFeatures(angle, aspect, hip_y, head_below)
