"""The test data for the fall detector.

1. Synthetic scenarios: scripted body-point sequences (falls, bending, sitting...). Fast,
   no model or video needed; they test the fall logic on its own.
2. Multiple Cameras Fall Dataset: ground truth for 24 real scenarios x 8 cameras, plus the
   train/test split used by model_finetuning/finetune.py and evaluate.py.
"""

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


# ================================================================================================
# 1. Synthetic scenarios
# ================================================================================================
#
# Synthetic scenarios for the fall benchmark.
#
# Each scenario is a short, scripted "video" of COCO keypoints: a person stands, falls, bends,
# sits, and so on. No model runs: the keypoints are generated directly, with noise, so the
# benchmark tests the fall logic (features, rules, incident timing, track handling) quickly
# and the same way every time.
#
# Poses are written in body units: x across, y up from the floor, 1.0 = standing height.
# They are placed in a 1280x720 frame with a chosen size and position.

FRAME_W, FRAME_H = 1280, 720
SYNTHETIC_FPS = 10.0

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


def lying_low_camera(pose: np.ndarray) -> np.ndarray:
    """Flat on the floor, seen by a low camera with the legs pointing toward it: the knees and
    ankles show lower in the picture than the hips (as if standing on them), but the outline is
    clearly wider than tall. (Like the 11 Nov webcam test.)"""
    out = lying(pose)
    out[[13, 14]] = [(-0.12, -0.08), (-0.14, -0.08)]   # knees
    out[[15, 16]] = [(-0.24, -0.30), (-0.26, -0.30)]   # ankles
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
        Scenario("fall_low_camera", "Falls in front of a low camera, legs toward it (ankles look below hips)",
                 [Segment(S, 4.0), Segment(S, 0.0), Segment(lying_low_camera(S), 0.8),
                  Segment(lying_low_camera(S), 12.0)], fall_at=4.0, center=(640, 560)),
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
    """Turn a scenario into (time, people) frames at SYNTHETIC_FPS, as the pose tracker would report them."""
    rng = np.random.default_rng(seed)
    poses: list[np.ndarray] = []
    track_ids: list[int] = []
    prev, track = sc.segments[0].pose, 1
    for seg in sc.segments:
        if seg.track_id is not None:
            track = seg.track_id
        n = int(round(seg.seconds * SYNTHETIC_FPS))
        for i in range(n):
            w = (i + 1) / n
            poses.append((1 - w) * prev + w * seg.pose)
            track_ids.append(track)
        prev = seg.pose
    glitch_frames = {int(round(g * SYNTHETIC_FPS)) for g in sc.glitches}

    frames = []
    cx, floor = sc.center
    for i, (pose, tid) in enumerate(zip(poses, track_ids)):
        t = i / SYNTHETIC_FPS + rng.uniform(-0.01, 0.01)
        if i in glitch_frames:
            pose = lying(STAND_FRONT)
        if rng.random() < sc.drop_frame and i / SYNTHETIC_FPS > (sc.fall_at or 0):
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


# ================================================================================================
# 2. Multiple Cameras Fall Dataset (MCFD)
# ================================================================================================
#
# Ground truth for the Multiple Cameras Fall Dataset (MCFD).
#
#     E. Auvinet, C. Rougier, J. Meunier, A. St-Arnaud, J. Rousseau. "Multiple cameras fall
#     data set". Technical report 1350, DIRO, Université de Montréal, 2010.
#     Kaggle copy: https://www.kaggle.com/datasets/soumicksarker/multiple-cameras-fall-dataset
#
# 24 scenarios, each filmed by 8 ceiling cameras around one room (cam1.avi ... cam8.avi, 720x480).
# One person acts out falls and everyday activities (sitting, crouching, lying on a sofa).
# Scenario 24 has no fall at all.
#
# The videos are not in this repo (3.6 GB). Point the benchmark at the folder that contains
# `dataset/dataset/chute01 ...` (or `chute01 ...` directly):
#
#     python -m evaluation.evaluate --mcfd "C:/datasets/Fall Dataset"
#     (or set ML_MCFD_DIR)
#
# The tables below are copied from the technical report (section 4):
# - PERIODS: what the person does, as (first frame, last frame, activity code). Frames are on
#   the report's common timeline; camera c shows the same moment at frame + DELAYS[s][c-1]
#   (the cameras started at different times; the report aligns them on the end of recording).
#   Checked: the delays equal each video's frame count minus the scenario's shortest, exactly,
#   for scenarios 1-23 (in 24, which has no fall, camera 8 is 1 s off). The fall windows in the
#   Kaggle file data_tuple3.csv agree within 0.2 s, apart from a few errors in that file
#   (scenario 7 camera 5, scenario 20 camera 3, the first fall of 23, a row for "camera 55").
# - The .avi headers claim 120 fps, but the footage is 30 fps (a fall takes ~0.7 s at 30 fps;
#   at 120 fps it would be an impossible 0.2 s), so FPS is fixed at 30 here.

MCFD_FPS = 30.0

ACTIVITY = {
    1: "walking/standing", 2: "falling", 3: "lying on the ground", 4: "crouching",
    5: "moving down", 6: "moving up", 7: "sitting", 8: "lying on a sofa", 9: "moving horizontally",
}
FALLING, LYING_GROUND = 2, 3

# Train/test split for anything trained on this dataset (model_finetuning/). Testing uses scenarios AND
# camera positions the models never saw. Test: 6 falls with a long time on the floor, one
# short fall with a sofa (13), sitting (21) and no fall at all (24).
TEST_SCENARIOS = (2, 5, 7, 10, 13, 19, 21, 24)
TRAIN_SCENARIOS = tuple(s for s in range(1, 25) if s not in TEST_SCENARIOS)
VAL_SCENARIOS = (3, 20)          # held out of TRAIN_SCENARIOS while training, to pick the best epoch
TEST_CAMERAS = (3, 5, 8)
TRAIN_CAMERAS = (1, 2, 4, 6, 7)

# Scenario -> delay in frames of cameras 1..8. Scenario 5 camera 5 is printed as "18 7" in the
# report; the frame counts give 18.
DELAYS = {
    1: (3, 3, 8, 4, 23, 6, 6, 0), 2: (25, 40, 0, 16, 18, 33, 33, 6), 3: (12, 16, 8, 16, 35, 20, 20, 0),
    4: (72, 79, 78, 0, 68, 82, 83, 56), 5: (17, 24, 5, 11, 18, 26, 28, 0),
    6: (0, 100, 106, 90, 89, 103, 104, 89), 7: (28, 14, 16, 0, 1, 17, 18, 20),
    8: (92, 79, 0, 81, 64, 81, 82, 56), 9: (18, 9, 1, 19, 13, 11, 12, 0), 10: (14, 15, 19, 33, 12, 17, 19, 0),
    11: (23, 4, 20, 14, 0, 6, 7, 12), 12: (21, 6, 13, 8, 0, 3, 7, 0), 13: (16, 33, 0, 7, 27, 27, 36, 13),
    14: (49, 36, 38, 0, 29, 29, 7, 14), 15: (15, 19, 19, 15, 34, 40, 23, 0), 16: (23, 29, 0, 2, 12, 9, 3, 3),
    17: (21, 26, 15, 0, 10, 0, 29, 18), 18: (99, 105, 86, 0, 84, 108, 109, 77),
    19: (19, 27, 16, 19, 5, 29, 0, 20), 20: (25, 9, 3, 10, 10, 4, 5, 0), 21: (20, 30, 22, 3, 8, 33, 32, 0),
    22: (0, 46, 51, 41, 53, 46, 47, 34), 23: (31, 52, 52, 45, 54, 60, 50, 0), 24: (3, 36, 7, 0, 37, 10, 33, 1),
}

PERIODS = {
    1: [(874, 1011, 1), (1012, 1079, 6), (1080, 1108, 2), (1109, 1285, 3)],
    2: [(308, 374, 1), (375, 399, 2), (400, 600, 3)],
    3: [(380, 590, 1), (591, 625, 2), (626, 784, 3)],
    4: [(230, 287, 1), (288, 314, 2), (315, 380, 3), (381, 600, 6), (601, 638, 2), (639, 780, 3)],
    5: [(288, 310, 1), (311, 336, 2), (337, 450, 3)],
    6: [(325, 582, 1), (583, 629, 2), (630, 750, 3)],
    7: [(330, 475, 1), (476, 507, 2), (508, 680, 3)],
    8: [(144, 270, 1), (271, 298, 2), (299, 380, 3)],
    9: [(310, 472, 1), (473, 505, 5), (506, 576, 7), (577, 627, 6), (628, 651, 2), (652, 760, 3)],
    10: [(315, 461, 1), (462, 511, 5), (512, 530, 2), (531, 680, 3)],
    11: [(378, 463, 1), (464, 489, 2), (490, 600, 3)],
    12: [(355, 604, 1), (605, 653, 2), (654, 770, 3)],
    13: [(301, 430, 1), (431, 476, 5), (477, 525, 7), (526, 636, 5), (637, 717, 8), (718, 780, 6),
         (781, 822, 6), (823, 863, 2), (864, 960, 3)],
    14: [(372, 555, 1), (556, 590, 5), (591, 856, 8), (857, 934, 6), (935, 988, 6), (989, 1023, 2),
         (1024, 1115, 3)],
    15: [(363, 486, 1), (487, 530, 5), (531, 630, 7), (631, 754, 6), (755, 787, 2), (788, 870, 3)],
    16: [(380, 455, 1), (456, 488, 5), (489, 530, 4), (531, 568, 6), (569, 629, 5), (630, 645, 4),
         (646, 670, 6), (671, 731, 5), (732, 817, 7), (818, 890, 6), (891, 940, 2), (941, 1000, 3)],
    17: [(251, 315, 1), (316, 340, 5), (341, 361, 4), (362, 388, 6), (389, 410, 5), (411, 430, 4),
         (431, 460, 6), (461, 531, 5), (532, 620, 7), (621, 729, 6), (730, 770, 2), (771, 860, 3)],
    18: [(301, 378, 1), (379, 430, 5), (431, 530, 7), (531, 570, 6), (571, 601, 2), (602, 740, 3)],
    19: [(255, 498, 1), (499, 600, 2), (601, 770, 3)],
    20: [(301, 544, 1), (545, 672, 2), (673, 800, 3)],
    21: [(408, 537, 1), (538, 608, 5), (609, 794, 7), (795, 863, 6), (864, 901, 2), (902, 1040, 3)],
    22: [(317, 586, 1), (587, 685, 5), (686, 737, 7), (738, 766, 6), (767, 808, 2), (809, 930, 3)],
    23: [(393, 662, 1), (663, 688, 5), (689, 710, 4), (711, 744, 6), (745, 1519, 1), (1520, 1595, 2),
         (1596, 1661, 6), (1662, 1730, 1), (1731, 1769, 5), (1770, 1839, 4), (1840, 1886, 6),
         (1887, 2645, 1), (2646, 2698, 5), (2699, 2958, 8), (2959, 3035, 6), (3036, 3156, 1),
         (3157, 3237, 5), (3238, 3416, 8), (3417, 3573, 6), (3574, 3614, 2), (3615, 3745, 6),
         (3746, 3795, 5), (3796, 4042, 4), (4043, 4105, 6), (4106, 4204, 1), (4205, 4264, 5),
         (4265, 4440, 7), (4441, 4527, 6), (4528, 5200, 1)],
    24: [(350, 974, 1), (975, 1315, 1), (1316, 1351, 5), (1352, 1414, 4), (1415, 1450, 6),
         (1451, 1750, 1), (1751, 1805, 5), (1806, 1844, 4), (1845, 1884, 6), (1885, 2490, 1),
         (2491, 2514, 5), (2515, 2563, 4), (2564, 2587, 6), (2588, 3040, 1), (3041, 3077, 5),
         (3078, 3125, 6), (3126, 3243, 1), (3244, 3353, 1), (3354, 3401, 5), (3402, 3500, 4)],
}


@dataclass(frozen=True)
class Fall:
    start: float          # seconds on the common timeline
    end: float            # end of the lying that follows (or of the fall, if they get straight up)
    lying_s: float        # how long they lay on the ground afterwards (0 = got straight up)


def seconds(frame: int) -> float:
    return frame / MCFD_FPS


def falls(scenario: int) -> list[Fall]:
    out = []
    periods = PERIODS[scenario]
    for i, (a, b, code) in enumerate(periods):
        if code != FALLING:
            continue
        nxt = periods[i + 1] if i + 1 < len(periods) else None
        if nxt and nxt[2] == LYING_GROUND:
            out.append(Fall(seconds(a), seconds(nxt[1] + 1), seconds(nxt[1] + 1 - nxt[0])))
        else:
            out.append(Fall(seconds(a), seconds(b + 1), 0.0))
    return out


def activity_at(scenario: int, t: float) -> int | None:
    """Activity code at time t (common timeline), None outside the annotated part."""
    f = t * MCFD_FPS
    for a, b, code in PERIODS[scenario]:
        if a <= f < b + 1:
            return code
    return None


def annotated(scenario: int) -> tuple[float, float]:
    periods = PERIODS[scenario]
    return seconds(periods[0][0]), seconds(periods[-1][1] + 1)


def video_path(root: Path, scenario: int, camera: int) -> Path:
    for base in (root / "dataset" / "dataset", root / "dataset", root):
        p = base / f"chute{scenario:02d}" / f"cam{camera}.avi"
        if p.exists():
            return p
    return root / "dataset" / "dataset" / f"chute{scenario:02d}" / f"cam{camera}.avi"


def parse_list(text: str, low: int, high: int) -> list[int]:
    """'1,3,5-7' -> [1, 3, 5, 6, 7]"""
    out: list[int] = []
    for part in text.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += range(int(a), int(b) + 1)
        elif part:
            out.append(int(part))
    bad = [x for x in out if not low <= x <= high]
    if bad:
        raise ValueError(f"out of range {low}-{high}: {bad}")
    return sorted(set(out))
