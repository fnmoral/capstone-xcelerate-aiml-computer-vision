"""Ground truth for the Multiple Cameras Fall Dataset (MCFD).

    E. Auvinet, C. Rougier, J. Meunier, A. St-Arnaud, J. Rousseau. "Multiple cameras fall
    data set". Technical report 1350, DIRO, Université de Montréal, 2010.
    Kaggle copy: https://www.kaggle.com/datasets/soumicksarker/multiple-cameras-fall-dataset

24 scenarios, each filmed by 8 ceiling cameras around one room (cam1.avi ... cam8.avi, 720x480).
One person acts out falls and everyday activities (sitting, crouching, lying on a sofa).
Scenario 24 has no fall at all.

The videos are not in this repo (3.6 GB). Point the benchmark at the folder that contains
`dataset/dataset/chute01 ...` (or `chute01 ...` directly):

    python -m eval.benchmark --mcfd "C:/datasets/Fall Dataset"
    (or set ML_MCFD_DIR)

The tables below are copied from the technical report (section 4):
- PERIODS: what the person does, as (first frame, last frame, activity code). Frames are on
  the report's common timeline; camera c shows the same moment at frame + DELAYS[s][c-1]
  (the cameras started at different times; the report aligns them on the end of recording).
  Checked: the delays equal each video's frame count minus the scenario's shortest, exactly,
  for scenarios 1-23 (in 24, which has no fall, camera 8 is 1 s off). The fall windows in the
  Kaggle file data_tuple3.csv agree within 0.2 s, apart from a few errors in that file
  (scenario 7 camera 5, scenario 20 camera 3, the first fall of 23, a row for "camera 55").
- The .avi headers claim 120 fps, but the footage is 30 fps (a fall takes ~0.7 s at 30 fps;
  at 120 fps it would be an impossible 0.2 s), so FPS is fixed at 30 here.
"""

from dataclasses import dataclass
from pathlib import Path

FPS = 30.0

ACTIVITY = {
    1: "walking/standing", 2: "falling", 3: "lying on the ground", 4: "crouching",
    5: "moving down", 6: "moving up", 7: "sitting", 8: "lying on a sofa", 9: "moving horizontally",
}
FALLING, LYING_GROUND = 2, 3

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
    return frame / FPS


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
    f = t * FPS
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
