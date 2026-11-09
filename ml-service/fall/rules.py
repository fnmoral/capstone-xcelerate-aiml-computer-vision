"""Stage A fall classifier: hand-tuned rules over pose features.

Works without training data. Stage B (a learned model over keypoint sequences)
should expose the same classify() signature so it can replace this class.
"""

from dataclasses import dataclass

from fall.features import PoseFeatures

UPRIGHT = "upright"
FALLING = "falling"
LYING = "lying"
UNCLEAR = "unclear"  # too little of the person is visible to tell; doesn't move an incident either way


@dataclass(slots=True)
class RuleThresholds:
    lying_torso_angle_deg: float = 60.0
    falling_torso_angle_deg: float = 35.0
    lying_aspect_ratio: float = 1.3
    fall_velocity: float = 1.2  # hip drop speed, in the person's torso lengths per second
    standing_legs: float = 0.6  # legs_upright at or above this = on their feet, so not lying
    min_visible_keypoints: int = 6  # fewer than this = unclear


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


class RuleClassifier:
    name = "rules"
    version = "0.2.0"

    def __init__(self, thresholds: RuleThresholds):
        self.t = thresholds

    def classify(self, f: PoseFeatures, hip_velocity: float | None) -> tuple[str, float]:
        """Return (label, confidence) for one pose. hip_velocity > 0 means moving down."""
        t = self.t
        # Too few points, or no hips/legs at all (e.g. sitting behind a table): the box shape
        # alone is not evidence of lying, so say nothing rather than guess.
        if f.visible < t.min_visible_keypoints or not f.lower_body or f.torso_angle_deg is None:
            return UNCLEAR, 0.0

        lying_score = _clamp((f.torso_angle_deg - 30.0) / (t.lying_torso_angle_deg - 30.0))
        # A box cut off by the frame edge has the wrong shape: then trust the body angle only.
        if not f.at_edge:
            aspect_score = _clamp((f.aspect_ratio - 0.8) / (t.lying_aspect_ratio - 0.8))
            lying_score = 0.7 * lying_score + 0.3 * aspect_score
        if f.head_below_hips:
            lying_score = _clamp(lying_score + 0.15)
        # Ankles well below the hips on straight legs: standing or bent over, not lying,
        # however tilted the upper body is.
        if f.legs_upright is not None and f.legs_upright >= t.standing_legs:
            lying_score = min(lying_score, 0.5)

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
