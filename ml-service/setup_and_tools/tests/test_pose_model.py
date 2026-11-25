"""Tests for app/detection/pose_model.py: choosing the device, the lap stand-in, duplicate boxes.
"""

import importlib.util
import itertools
from pathlib import Path
from unittest import mock

import numpy as np

from app.detection.pose_model import drop_duplicates, resolve_device


# ================================================================================================
# 1. Choosing GPU or CPU
# ================================================================================================

def test_auto_uses_gpu_when_cuda_available():
    with mock.patch("torch.cuda.is_available", return_value=True):
        assert resolve_device("auto") == 0


def test_auto_uses_cpu_without_cuda():
    with mock.patch("torch.cuda.is_available", return_value=False):
        assert resolve_device("auto") == "cpu"
        assert resolve_device("AUTO") == "cpu"


def test_explicit_gpu_falls_back_to_cpu_without_cuda():
    with mock.patch("torch.cuda.is_available", return_value=False):
        assert resolve_device(0) == "cpu"


def test_explicit_values_pass_through():
    with mock.patch("torch.cuda.is_available", return_value=True):
        assert resolve_device(0) == 0
        assert resolve_device("cpu") == "cpu"


# ================================================================================================
# 2. The lap stand-in used by the tracker
# ================================================================================================
#
# app/detection/lap_compat/lap.py, the stand-in for the `lap` package (tested even when the real one is installed).

_spec = importlib.util.spec_from_file_location(
    "lap_shim", Path(__file__).resolve().parents[2] / "app" / "detection" / "lap_compat" / "lap.py")
lap_shim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lap_shim)
lapjv = lap_shim.lapjv


def brute_force(cost, limit):
    """Cheapest matching where each pair costs at most `limit` and leaving a row or column out costs limit / 2."""
    n, m = cost.shape
    best = None
    for k in range(min(n, m) + 1):
        for rows in itertools.combinations(range(n), k):
            for cols in itertools.permutations(range(m), k):
                if any(cost[r, c] > limit for r, c in zip(rows, cols)):
                    continue
                total = sum(cost[r, c] for r, c in zip(rows, cols)) + (n - k + m - k) * limit / 2
                if best is None or total < best:
                    best = total
    return best


def test_matches_brute_force():
    rng = np.random.default_rng(0)
    for _ in range(200):
        n, m = rng.integers(1, 5, size=2)
        cost = rng.random((n, m))
        limit = float(rng.uniform(0.2, 1.0))
        total, x, y = lapjv(cost, extend_cost=True, cost_limit=limit)

        matched = [(r, c) for r, c in enumerate(x) if c >= 0]
        assert all(y[c] == r for r, c in matched)
        assert all(cost[r, c] <= limit for r, c in matched)
        k = len(matched)
        assert abs(total + (n - k + m - k) * limit / 2 - brute_force(cost, limit)) < 1e-9


def test_empty():
    _, x, y = lapjv(np.zeros((0, 3)), extend_cost=True, cost_limit=0.5)
    assert len(x) == 0 and list(y) == [-1, -1, -1]


# ================================================================================================
# Duplicate boxes of one person
# ================================================================================================

def test_partial_box_inside_a_stronger_one_is_dropped():
    xyxy = np.array([[100, 300, 400, 380], [100, 300, 230, 370]], dtype=float)  # whole body, upper body
    assert drop_duplicates(xyxy, np.array([0.9, 0.5]), [0, 1]) == [0]


def test_weaker_big_box_around_a_stronger_one_is_dropped():
    xyxy = np.array([[100, 300, 230, 370], [90, 290, 420, 400]], dtype=float)  # e.g. spanning two people
    assert drop_duplicates(xyxy, np.array([0.9, 0.5]), [0, 1]) == [0]


def test_two_people_overlapping_a_little_are_both_kept():
    # Someone standing over a person on the floor.
    xyxy = np.array([[100, 300, 400, 380], [300, 100, 360, 360]], dtype=float)
    assert drop_duplicates(xyxy, np.array([0.9, 0.8]), [0, 1]) == [0, 1]


def test_only_the_given_indexes_are_considered():
    xyxy = np.array([[100, 300, 400, 380], [100, 300, 230, 370], [500, 100, 560, 300]], dtype=float)
    assert drop_duplicates(xyxy, np.array([0.9, 0.95, 0.8]), [0, 2]) == [0, 2]
