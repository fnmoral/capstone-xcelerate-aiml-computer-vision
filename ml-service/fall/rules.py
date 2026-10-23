"""Stage A fall classifier: hand-tuned rules over pose features.

Works without training data. Stage B (a learned model over keypoint sequences)
should expose the same classify() signature so it can replace this class.
"""

from dataclasses import dataclass

from fall.features import PoseFeatures

UPRIGHT = "upright"
FALLING = "falling"
LYING = "lying"


@dataclass(slots=True)
class RuleThresholds:
    lying_torso_angle_deg: float = 60.0
    falling_torso_angle_deg: float = 35.0
    lying_aspect_ratio: float = 1.3
    fall_velocity: float = 0.6  # hip drop speed, in frame heights per second


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


class RuleClassifier:
    name = "rules"
    version = "0.1.0"

    def __init__(self, thresholds: RuleThresholds):
        self.t = thresholds

    def classify(self, f: PoseFeatures, hip_velocity: float | None) -> tuple[str, float]:
        """Return (label, confidence) for one pose. hip_velocity > 0 means moving down."""
        t = self.t

        lying_score = 0.0
        if f.torso_angle_deg is not None:
            lying_score = _clamp((f.torso_angle_deg - 30.0) / (t.lying_torso_angle_deg - 30.0))
        aspect_score = _clamp((f.aspect_ratio - 0.8) / (t.lying_aspect_ratio - 0.8))
        # Without a torso angle the box shape is the only evidence, so weight it fully.
        if f.torso_angle_deg is None:
            lying_score = aspect_score
        else:
            lying_score = 0.7 * lying_score + 0.3 * aspect_score
        if f.head_below_hips:
            lying_score = _clamp(lying_score + 0.15)

        if lying_score >= 0.75:
            return LYING, lying_score

        if (
            hip_velocity is not None
            and hip_velocity >= t.fall_velocity
            and f.torso_angle_deg is not None
            and f.torso_angle_deg >= t.falling_torso_angle_deg
        ):
            return FALLING, _clamp(0.5 + hip_velocity / (2 * t.fall_velocity) * 0.5)

        return UPRIGHT, 1.0 - lying_score
