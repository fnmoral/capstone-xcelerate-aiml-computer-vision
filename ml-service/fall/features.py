"""Geometric features of a single pose, used by the fall rules."""

import math
from dataclasses import dataclass

import numpy as np

# COCO keypoint indices
NOSE = 0
L_SHOULDER, R_SHOULDER = 5, 6
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14
L_ANKLE, R_ANKLE = 15, 16


@dataclass(slots=True)
class PoseFeatures:
    torso_angle_deg: float | None  # 0 = upright, 90 = horizontal
    aspect_ratio: float            # box width / height; > 1 means wider than tall
    hip_y: float | None            # hip height as a fraction of frame height (0 = top)
    head_below_hips: bool | None
    legs_upright: float | None = None  # 1 = legs straight down under the hips (standing), 0 = legs flat
    visible: int = 17                  # keypoints at or above min_conf
    lower_body: bool = True            # any hip, knee or ankle visible
    at_edge: bool = False              # box touches the frame edge: the person may be cut off
    angle_source: str = "torso"        # "torso" (shoulders-hips), "body" (head-legs fallback) or "none"


def _midpoint(kpts: np.ndarray, a: int, b: int, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in (a, b) if kpts[i, 2] >= min_conf]
    if not pts:
        return None
    return np.mean(pts, axis=0)


def _legs_upright(kpts: np.ndarray, min_conf: float) -> float | None:
    """How far the ankles are below the hips, as a share of the leg's length (hip-knee-ankle).

    Standing or bending over: about 1. Sitting on a chair: about 0.5. Lying: about 0.
    Leg length is measured along the leg, so it doesn't depend on which way the body faces.
    """
    ratios = []
    for hip, knee, ankle in ((L_HIP, L_KNEE, L_ANKLE), (R_HIP, R_KNEE, R_ANKLE)):
        if min(kpts[hip, 2], kpts[knee, 2], kpts[ankle, 2]) < min_conf:
            continue
        length = np.linalg.norm(kpts[knee, :2] - kpts[hip, :2]) + np.linalg.norm(kpts[ankle, :2] - kpts[knee, :2])
        if length > 1.0:
            ratios.append((kpts[ankle, 1] - kpts[hip, 1]) / length)
    return float(np.mean(ratios)) if ratios else None


def _group_mean(kpts: np.ndarray, idx: range, min_conf: float) -> np.ndarray | None:
    pts = [kpts[i, :2] for i in idx if kpts[i, 2] >= min_conf]
    return np.mean(pts, axis=0) if pts else None


def _angle(top: np.ndarray, bottom: np.ndarray) -> float:
    dx, dy = top - bottom
    return math.degrees(math.atan2(abs(dx), abs(dy)))


EDGE_PX = 3


def extract(box: np.ndarray, kpts: np.ndarray, frame_shape: tuple[int, ...], min_conf: float) -> PoseFeatures:
    frame_h, frame_w = frame_shape[:2]
    x1, y1, x2, y2 = box
    aspect = float((x2 - x1) / max(y2 - y1, 1.0))
    at_edge = bool(x1 <= EDGE_PX or y1 <= EDGE_PX or x2 >= frame_w - 1 - EDGE_PX or y2 >= frame_h - 1 - EDGE_PX)
    visible = int((kpts[:, 2] >= min_conf).sum())

    shoulders = _midpoint(kpts, L_SHOULDER, R_SHOULDER, min_conf)
    hips = _midpoint(kpts, L_HIP, R_HIP, min_conf)
    lower = _group_mean(kpts, range(L_HIP, R_ANKLE + 1), min_conf)

    angle, source = None, "none"
    if shoulders is not None and hips is not None:
        angle, source = _angle(shoulders, hips), "torso"
    else:
        # No torso line: use the head/shoulders to the legs instead.
        upper = _group_mean(kpts, range(NOSE, R_SHOULDER + 1), min_conf)
        if upper is not None and lower is not None:
            angle, source = _angle(upper, lower), "body"

    hip_y = float(hips[1] / frame_h) if hips is not None else None

    head_below = None
    if hips is not None and kpts[NOSE, 2] >= min_conf:
        head_below = bool(kpts[NOSE, 1] > hips[1])

    return PoseFeatures(angle, aspect, hip_y, head_below, _legs_upright(kpts, min_conf),
                        visible, lower is not None, at_edge, source)
