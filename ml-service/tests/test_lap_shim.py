import itertools
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "compat"))
from lap import lapjv  # noqa: E402


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
