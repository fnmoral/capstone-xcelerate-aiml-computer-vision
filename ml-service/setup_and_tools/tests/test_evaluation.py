"""Tests for evaluation/: the datasets and the benchmark (no videos needed)."""

import numpy as np
import pytest

from app.config import Config
from app.detection.pose_model import PoseTracker
from evaluation import datasets as mcfd
from evaluation.evaluate import _new_tally, run_synthetic, score_mcfd, summarize


# ================================================================================================
# 1. Benchmark regression guard
# ================================================================================================
#
# Regression guard: the synthetic fall benchmark must stay clean.
#
# If a change makes this fail, run `python -m evaluation.evaluate --compare <latest>` to see which
# scenario got worse. See DETECTION_CHANGELOG.md.

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


# ================================================================================================
# 2. Multiple Cameras Fall Dataset
# ================================================================================================
#
# The Multiple Cameras Fall Dataset ground truth and scoring (no videos needed).

def test_every_scenario_is_annotated_in_order():
    assert sorted(mcfd.PERIODS) == list(range(1, 25)) == sorted(mcfd.DELAYS)
    for s, periods in mcfd.PERIODS.items():
        assert all(len(d) == 8 for d in [mcfd.DELAYS[s]])
        for (a, b, code), (a2, _, _) in zip(periods, periods[1:]):
            assert a <= b < a2 and code in mcfd.ACTIVITY, s


def test_falls_and_time_on_the_ground():
    (f,) = mcfd.falls(1)  # falls at frame 1080, lies 1109-1285
    assert f.start == 1080 / 30 and abs(f.lying_s - 177 / 30) < 1e-9
    assert [x.lying_s for x in mcfd.falls(23)] == [0.0, 0.0]  # gets straight back up, twice
    assert mcfd.falls(24) == []
    assert sum(len(mcfd.falls(s)) for s in mcfd.PERIODS) == 25


def test_activity_at():
    assert mcfd.activity_at(13, 680 / 30) == 8   # lying on a sofa
    assert mcfd.activity_at(1, 10.0) is None     # before the annotations


def test_scoring_short_falls_duplicates_and_false_alarms():
    need = 3.5
    tally = _new_tally()
    fall_t = 1080 / 30
    # Scenario 1: one alert 3 s after the fall, one duplicate, one alert while walking earlier.
    row = score_mcfd(1, [(fall_t + 3.0, fall_t), (fall_t + 4.0, fall_t + 1), (30.0, 30.0)], need, tally)
    assert row == {"expected": 1, "caught": 1, "short": 0, "short_caught": 0, "false_alarms": 1}
    assert tally["duplicates"] == 1 and tally["false_alarms"] == {"walking/standing": 1}
    # Scenario 4: first fall has only 2.2 s on the ground, so it's "short", not a miss.
    row = score_mcfd(4, [], need, tally)
    assert row["short"] == 1 and row["expected"] == 1 and row["caught"] == 0


@pytest.mark.parametrize("text,expected", [("1,3-5", [1, 3, 4, 5]), ("8", [8]), ("2,2", [2])])
def test_parse_list(text, expected):
    assert mcfd.parse_list(text, 1, 8) == expected


def test_parse_list_rejects_out_of_range():
    with pytest.raises(ValueError):
        mcfd.parse_list("0,9", 1, 8)


def test_cache_key_changes_when_the_model_file_is_replaced(tmp_path):
    """A retrained model saved under the same name must not be served the old model's cached results."""
    import dataclasses
    import os

    from evaluation.evaluate import _fingerprint
    video = tmp_path / "v.mp4"
    video.write_bytes(b"video")
    weights = tmp_path / "model.pt"
    weights.write_bytes(b"old model")
    cfg = Config()
    cfg = dataclasses.replace(cfg, inference=dataclasses.replace(cfg.inference, weights=str(weights)))
    before = _fingerprint(cfg, video)
    weights.write_bytes(b"new, retrained model")
    os.utime(weights, (1_900_000_000, 1_900_000_000))
    assert _fingerprint(cfg, video) != before
