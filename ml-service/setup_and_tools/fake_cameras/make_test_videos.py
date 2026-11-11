"""Make the test videos (test_videos/test.mp4 and fall.mp4) from the Multiple Cameras Fall Dataset.

    python setup_and_tools/fake_cameras/make_test_videos.py --mcfd "C:/datasets/Fall Dataset"

Both are real falls from the dataset's held-out test scenarios (evaluation/datasets.py), so
they never overlap with training data:

- test.mp4: streamed on a loop by the test-camera Docker service (rtsp://test-camera:8554/test)
- fall.mp4: a second fall, used with test.mp4 by the benchmark's "recorded videos" part

The dataset's .avi files claim 120 fps but are 30 fps, so they are rewritten as .mp4 at 30 fps;
otherwise the test camera would play them four times too fast. The ground truth for both is
written to evaluation/videos.yaml at the same time, so clips and ground truth always match.
The videos are git-ignored: every teammate runs this once with their own copy of the dataset.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import cv2

ML = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ML))

from evaluation import datasets as mcfd  # noqa: E402

OUT = ML.parent / "test_videos"
VIDEOS_YAML = ML / "evaluation" / "videos.yaml"
# (file, scenario, camera, description). Both scenarios are in mcfd.TEST_SCENARIOS.
CLIPS = [
    ("test.mp4", 5, 3, "Real fall (dataset scenario 5, camera 3): falls, lies 3.8 s, gets up."),
    ("fall.mp4", 2, 3, "Real fall (dataset scenario 2, camera 3): falls, lies 6.7 s."),
]


def convert(src: Path, dst: Path) -> int:
    cap = cv2.VideoCapture(str(src))
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out = cv2.VideoWriter(str(dst), cv2.VideoWriter_fourcc(*"mp4v"), mcfd.MCFD_FPS, (w, h))
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        out.write(frame)
        n += 1
    cap.release()
    out.release()
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcfd", default=os.environ.get("ML_MCFD_DIR"), required=not os.environ.get("ML_MCFD_DIR"))
    args = ap.parse_args()
    root = Path(args.mcfd)
    OUT.mkdir(exist_ok=True)

    lines = ["# Ground truth for recorded videos used by the benchmark (python -m evaluation.evaluate).",
             "# Written by setup_and_tools/fake_cameras/make_test_videos.py: re-run that instead of editing.",
             "# Paths are relative to this file. A missing file is skipped: videos are git-ignored.",
             "# falls: [start, end] in seconds of the video for every period someone is down.",
             "videos:"]
    for name, s, c, note in CLIPS:
        assert s in mcfd.TEST_SCENARIOS and c in mcfd.TEST_CAMERAS, "test clips must come from the held-out test set"
        n = convert(mcfd.video_path(root, s, c), OUT / name)
        shift = mcfd.DELAYS[s][c - 1] / mcfd.MCFD_FPS     # the common timeline -> this camera's file
        falls = [[round(f.start + shift, 2), round(f.end + shift, 2)] for f in mcfd.falls(s)]
        lines += [f"  - path: ../../test_videos/{name}", f"    falls: {falls}", f"    note: {json.dumps(note)}"]
        print(f"{name}: scenario {s} camera {c}, {n} frames ({n / mcfd.MCFD_FPS:.0f} s), falls at {falls}")
    VIDEOS_YAML.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {VIDEOS_YAML.relative_to(ML)}")


if __name__ == "__main__":
    main()
