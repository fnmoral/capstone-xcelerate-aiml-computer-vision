"""Stand-in for the `lap` package, which has no Python 3.15 wheels yet.

Ultralytics' ByteTrack calls lap.lapjv(cost, extend_cost=True, cost_limit=thresh).
This reproduces that call on top of Ultralytics' own pure-NumPy assignment solver.
vision/pose.py only puts this on the path when the real package is missing, so
delete this folder once `pip install lap` works on 3.15.
"""

import numpy as np
from ultralytics.utils.ops import linear_sum_assignment

__version__ = "0.0+ml-service-shim"


def lapjv(cost, extend_cost=False, cost_limit=np.inf, return_cost=True):
    """Return (total_cost, x, y): x[row] = assigned column or -1, y[col] = assigned row or -1."""
    cost = np.asarray(cost, dtype=np.float64)
    n, m = cost.shape
    x = np.full(n, -1, dtype=int)
    y = np.full(m, -1, dtype=int)
    if n == 0 or m == 0:
        return (0.0, x, y) if return_cost else (x, y)

    if np.isfinite(cost_limit):
        # Same extension as lap: any row or column may stay unmatched at cost_limit / 2,
        # so pairs costing more than cost_limit are never chosen.
        size = n + m
        matrix = np.full((size, size), cost_limit / 2.0)
        matrix[n:, m:] = 0.0
        matrix[:n, :m] = cost
    else:
        matrix = cost

    total = 0.0
    for r, c in zip(*linear_sum_assignment(matrix)):
        if r < n and c < m:
            x[r], y[c] = c, r
            total += cost[r, c]
    return (total, x, y) if return_cost else (x, y)
