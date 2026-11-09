"""Synthetic scenarios for the fall benchmark.

Each scenario is a short, scripted "video" of COCO keypoints: a person stands, falls, bends,
sits, and so on. No model runs: the keypoints are generated directly, with noise, so the
benchmark tests the fall logic (features, rules, incident timing, track handling) quickly
and the same way every time.

Poses are written in body units: x across, y up from the floor, 1.0 = standing height.
They are placed in a 1280x720 frame with a chosen size and position.
"""

from dataclasses import dataclass, field

import numpy as np

FRAME_W, FRAME_H = 1280, 720
FPS = 10.0

# COCO order: nose, eyes(2), ears(2), shoulders(2), elbows(2), wrists(2), hips(2), knees(2), ankles(2)
STAND_FRONT = np.array([
    (0.00, 0.93), (0.02, 0.95), (-0.02, 0.95), (0.05, 0.94), (-0.05, 0.94),
    (0.11, 0.81), (-0.11, 0.81), (0.14, 0.63), (-0.14, 0.63), (0.15, 0.47), (-0.15, 0.47),
    (0.07, 0.52), (-0.07, 0.52), (0.07, 0.28), (-0.07, 0.28), (0.07, 0.04), (-0.07, 0.04),
])
# Seen from the side, facing +x.
STAND_SIDE = np.array([
    (0.06, 0.93), (0.05, 0.95), (0.05, 0.95), (0.00, 0.94), (0.00, 0.94),
    (0.01, 0.81), (-0.01, 0.81), (0.02, 0.63), (0.00, 0.63), (0.04, 0.47), (0.02, 0.47),
    (0.01, 0.52), (-0.01, 0.52), (0.02, 0.28), (0.00, 0.28), (0.00, 0.04), (-0.02, 0.04),
])
UPPER = slice(0, 11)   # nose..wrists
LEGS = slice(11, 17)   # hips..ankles
HIP_MID = np.array([0.0, 0.52])


def lying(pose: np.ndarray, head_right: bool = True) -> np.ndarray:
    """The pose rotated flat onto the floor."""
    out = np.empty_like(pose)
    sign = 1 if head_right else -1
    out[:, 0] = sign * (pose[:, 1] - 0.5)
    out[:, 1] = 0.07 + 0.3 * pose[:, 0]
    return out


def lying_toward_camera(pose: np.ndarray) -> np.ndarray:
    """Flat on the floor with the feet toward the camera: the body looks short and upright."""
    out = pose.copy()
    out[:, 1] = 0.05 + 0.25 * pose[:, 1]
    return out


def bend(pose: np.ndarray, degrees: float) -> np.ndarray:
    """Upper body pivots forward (toward +x) at the hips; legs stay straight."""
    out = pose.copy()
    a = np.radians(degrees)
    rot = np.array([[np.cos(a), np.sin(a)], [-np.sin(a), np.cos(a)]])
    out[UPPER] = (pose[UPPER] - HIP_MID) @ rot.T + HIP_MID
    return out


SIT_CHAIR = np.array([
    (0.08, 0.70), (0.07, 0.72), (0.07, 0.72), (0.02, 0.71), (0.02, 0.71),
    (0.02, 0.58), (0.00, 0.58), (0.10, 0.42), (0.08, 0.42), (0.22, 0.36), (0.20, 0.36),
    (0.01, 0.29), (-0.01, 0.29), (0.25, 0.29), (0.23, 0.29), (0.25, 0.04), (0.23, 0.04),
])
SQUAT = np.array([
    (0.17, 0.54), (0.16, 0.56), (0.16, 0.56), (0.12, 0.55), (0.12, 0.55),
    (0.11, 0.43), (0.09, 0.43), (0.20, 0.28), (0.18, 0.28), (0.28, 0.22), (0.26, 0.22),
    (-0.04, 0.17), (-0.06, 0.17), (0.18, 0.22), (0.16, 0.22), (0.01, 0.04), (-0.01, 0.04),
])
SIT_FLOOR = np.array([
    (0.04, 0.45), (0.03, 0.47), (0.03, 0.47), (-0.02, 0.46), (-0.02, 0.46),
    (-0.02, 0.33), (-0.04, 0.33), (0.04, 0.17), (0.02, 0.17), (0.15, 0.10), (0.13, 0.10),
    (0.01, 0.05), (-0.01, 0.05), (0.25, 0.09), (0.23, 0.09), (0.47, 0.04), (0.45, 0.04),
])
# Kneeling and looking under furniture: torso flat, head low.
KNEEL_LOOK = np.array([
    (0.46, 0.17), (0.45, 0.19), (0.45, 0.19), (0.41, 0.19), (0.41, 0.19),
    (0.32, 0.25), (0.30, 0.25), (0.36, 0.13), (0.34, 0.13), (0.42, 0.04), (0.40, 0.04),
    (0.03, 0.29), (0.01, 0.29), (0.14, 0.04), (0.12, 0.04), (-0.15, 0.04), (-0.17, 0.04),
])
ARMS_OUT = STAND_FRONT.copy()
ARMS_OUT[7:11] = [(0.30, 0.80), (-0.30, 0.80), (0.46, 0.80), (-0.46, 0.80)]
# Sitting at a table: only the upper body is visible, arms spread on the table top.
AT_TABLE = STAND_FRONT.copy()
AT_TABLE[7:11] = [(0.22, 0.62), (-0.22, 0.62), (0.32, 0.60), (-0.32, 0.60)]


@dataclass
class Segment:
    pose: np.ndarray       # pose at the END of the segment (linear blend from the previous one)
    seconds: float
    track_id: int | None = None   # change the tracker's ID from here on (an ID switch)


@dataclass
class Scenario:
    name: str
    description: str
    segments: list[Segment]
    fall_at: float | None = None          # ground truth: when the fall starts (None = no fall)
    height_px: float = 420.0
    center: tuple[float, float] = (640.0, 640.0)  # feet position in the frame
    noise: float = 0.006                  # keypoint jitter, in standing heights
    hide: tuple[int, ...] = ()            # keypoints never visible (occluded)
    drop_kpt: float = 0.03                # chance any one keypoint is missed in a frame
    drop_frame: float = 0.0               # chance the person isn't detected at all in a frame
    glitches: tuple[float, ...] = ()      # single frames where the detector reports a lying pose
    known_limit: bool = False             # expected to fail until a planned feature exists
    tags: list[str] = field(default_factory=list)


def scenarios() -> list[Scenario]:
    S, F = STAND_SIDE, STAND_FRONT
    fall_side = [Segment(S, 4.0), Segment(S, 0.0), Segment(lying(S), 0.8), Segment(lying(S), 12.0),
                 Segment(SIT_FLOOR, 1.5), Segment(S, 1.5), Segment(S, 4.0)]
    return [
        # ------------------------------------------------------------------ real falls
        Scenario("fall_side", "Falls sideways in front of the camera, lies 12 s, gets up",
                 fall_side, fall_at=4.0),
        Scenario("fall_front", "Falls over facing the camera",
                 [Segment(F, 4.0), Segment(F, 0.0), Segment(lying(F, head_right=False), 0.7),
                  Segment(lying(F, head_right=False), 12.0)], fall_at=4.0),
        Scenario("fall_far", "Falls far from the camera (person 110 px tall)",
                 fall_side, fall_at=4.0, height_px=110, center=(300, 330), noise=0.012),
        Scenario("fall_noisy", "Falls with jittery keypoints and many missed points",
                 fall_side, fall_at=4.0, noise=0.025, drop_kpt=0.25),
        Scenario("fall_legs_hidden", "Falls behind furniture: hips visible, legs hidden",
                 fall_side, fall_at=4.0, hide=(13, 14, 15, 16)),
        Scenario("fall_detection_gaps", "Falls; the detector misses the person in 40% of frames once down",
                 fall_side, fall_at=4.0, drop_frame=0.4),
        Scenario("fall_id_switch", "Falls; the tracker gives the person a new ID on landing and twice more",
                 [Segment(S, 4.0), Segment(S, 0.0), Segment(lying(S), 0.8, track_id=2),
                  Segment(lying(S), 2.4, track_id=3), Segment(lying(S), 2.4, track_id=4),
                  Segment(lying(S), 8.0)], fall_at=4.0),
        Scenario("fall_toward_camera", "Falls with the feet toward the camera (body looks short, upright)",
                 [Segment(F, 4.0), Segment(F, 0.0), Segment(lying_toward_camera(F), 0.8),
                  Segment(lying_toward_camera(F), 12.0)], fall_at=4.0, known_limit=True),
        # ------------------------------------------------------------------ everyday activity
        Scenario("walk", "Stands and walks around", [Segment(F, 15.0)]),
        Scenario("arms_out", "Stretches with both arms out wide", [Segment(F, 2.0), Segment(ARMS_OUT, 1.0),
                                                                    Segment(ARMS_OUT, 6.0), Segment(F, 1.0)]),
        Scenario("bend_tie_shoes", "Bends over for 6 s (tying shoes, making a bed)",
                 [Segment(S, 3.0), Segment(bend(S, 85), 1.0), Segment(bend(S, 85), 6.0), Segment(S, 1.0),
                  Segment(S, 3.0)]),
        Scenario("bend_deep", "Bends over deeply, head below the hips, for 5 s",
                 [Segment(S, 3.0), Segment(bend(S, 120), 1.0), Segment(bend(S, 120), 5.0), Segment(S, 1.0),
                  Segment(S, 3.0)]),
        Scenario("pick_up", "Quickly bends to pick something up",
                 [Segment(S, 3.0), Segment(bend(S, 80), 0.5), Segment(bend(S, 80), 1.0), Segment(S, 0.5),
                  Segment(S, 3.0)]),
        Scenario("sit_chair_fast", "Drops quickly into a chair and sits 12 s",
                 [Segment(S, 3.0), Segment(SIT_CHAIR, 0.4), Segment(SIT_CHAIR, 12.0)]),
        Scenario("squat", "Squats down for 6 s", [Segment(S, 3.0), Segment(SQUAT, 1.0), Segment(SQUAT, 6.0),
                                                    Segment(S, 1.0), Segment(S, 2.0)]),
        Scenario("sit_floor", "Sits down on the floor with legs out for 12 s",
                 [Segment(S, 3.0), Segment(SQUAT, 1.0), Segment(SIT_FLOOR, 1.0), Segment(SIT_FLOOR, 12.0)]),
        Scenario("at_table", "Sits at a table: only the upper body is visible, arms spread",
                 [Segment(AT_TABLE, 12.0)], hide=(11, 12, 13, 14, 15, 16)),
        Scenario("detector_glitches", "Stands; two single-frame lying misdetections 3 s apart",
                 [Segment(F, 12.0)], glitches=(3.0, 6.0)),
        Scenario("kneel_look_under", "Kneels and looks under furniture for 6 s, torso flat",
                 [Segment(S, 3.0), Segment(KNEEL_LOOK, 1.5), Segment(KNEEL_LOOK, 6.0), Segment(S, 1.5),
                  Segment(S, 2.0)], known_limit=True),
        Scenario("lie_on_bed", "Lies down slowly on a bed for 15 s",
                 [Segment(S, 3.0), Segment(SIT_CHAIR, 1.5), Segment(lying(S), 2.0), Segment(lying(S), 15.0)],
                 center=(640, 520), known_limit=True),
    ]


@dataclass(slots=True)
class SyntheticPerson:
    track_id: int
    box: np.ndarray
    keypoints: np.ndarray


def render(sc: Scenario, seed: int = 0) -> list[tuple[float, list[SyntheticPerson]]]:
    """Turn a scenario into (time, people) frames at FPS, as the pose tracker would report them."""
    rng = np.random.default_rng(seed)
    poses: list[np.ndarray] = []
    track_ids: list[int] = []
    prev, track = sc.segments[0].pose, 1
    for seg in sc.segments:
        if seg.track_id is not None:
            track = seg.track_id
        n = int(round(seg.seconds * FPS))
        for i in range(n):
            w = (i + 1) / n
            poses.append((1 - w) * prev + w * seg.pose)
            track_ids.append(track)
        prev = seg.pose
    glitch_frames = {int(round(g * FPS)) for g in sc.glitches}

    frames = []
    cx, floor = sc.center
    for i, (pose, tid) in enumerate(zip(poses, track_ids)):
        t = i / FPS + rng.uniform(-0.01, 0.01)
        if i in glitch_frames:
            pose = lying(STAND_FRONT)
        if rng.random() < sc.drop_frame and i / FPS > (sc.fall_at or 0):
            frames.append((t, []))
            continue
        xy = pose + rng.normal(0, sc.noise, pose.shape)
        px = np.stack([cx + xy[:, 0] * sc.height_px, floor - xy[:, 1] * sc.height_px], axis=1)
        conf = rng.uniform(0.55, 0.95, 17)
        conf[rng.random(17) < sc.drop_kpt] = rng.uniform(0.05, 0.25)
        conf[list(sc.hide)] = rng.uniform(0.0, 0.1, len(sc.hide))
        kpts = np.column_stack([px, conf]).astype(np.float32)
        seen = px[conf >= 0.3]
        pad = 0.04 * sc.height_px
        box = np.array([seen[:, 0].min() - pad, seen[:, 1].min() - 2 * pad,
                        seen[:, 0].max() + pad, seen[:, 1].max() + pad / 2], dtype=np.float32)
        box[[0, 2]] = box[[0, 2]].clip(0, FRAME_W - 1)
        box[[1, 3]] = box[[1, 3]].clip(0, FRAME_H - 1)
        frames.append((t, [SyntheticPerson(tid, box, kpts)]))
    return frames
