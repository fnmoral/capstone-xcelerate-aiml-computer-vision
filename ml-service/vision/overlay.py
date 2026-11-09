"""Draws detection boxes and labels on a frame, for the local preview window
(cfg.show). Not used on a stream-hub camera unless a preview window is also open."""

import cv2
import numpy as np

from fall.rules import FALLING, LYING
from vision.pose import Person

LABEL_COLORS = {LYING: (0, 0, 255), FALLING: (0, 165, 255)}
DEFAULT_COLOR = (0, 200, 0)


def annotate(frame: np.ndarray, camera_id: str, people: list[Person],
            labels: dict[int, tuple[str, float]]) -> np.ndarray:
    img = frame.copy()
    for p in people:
        label, conf = labels[p.track_id]
        color = LABEL_COLORS.get(label, DEFAULT_COLOR)
        x1, y1, x2, y2 = p.box.astype(int)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(img, f"#{p.track_id} {label} {conf:.2f}", (x1, max(y1 - 8, 16)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
    cv2.putText(img, camera_id, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
    return img