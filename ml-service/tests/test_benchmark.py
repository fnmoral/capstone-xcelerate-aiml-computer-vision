"""Regression guard: the synthetic fall benchmark must stay clean.

If a change makes this fail, run `python -m eval.benchmark --compare <latest>` to see which
scenario got worse. See DETECTION_CHANGELOG.md.
"""

import numpy as np

from config import Config
from eval.benchmark import run_synthetic, summarize
from vision.pose import PoseTracker


def test_synthetic_benchmark_catches_every_fall_without_false_alarms():
    results = run_synthetic(Config())
    summary = summarize(results, {})
    assert summary["synthetic_recall_pct"] == 100.0, results
    assert summary["synthetic_false_alarms"] == 0, results


def test_pose_tracker_keeps_confirmed_people_at_lower_confidence():
    tracker = object.__new__(PoseTracker)  # no model needed for the filtering logic
    tracker.conf, tracker._frame, tracker._confirmed = 0.4, 0, {}
    ids = np.array([1, 2])
    # Person 1 is detected confidently, person 2 never is.
    assert tracker._keep(ids, np.array([0.8, 0.2])) == [0]
    # Person 1 falls and their score drops: still reported. Person 2 still isn't.
    assert tracker._keep(ids, np.array([0.15, 0.2])) == [0]
    assert tracker._keep(ids, np.array([0.15, 0.45])) == [0, 1]
