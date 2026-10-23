"""FrameSampler keeps the analysis rate at target_fps on average."""

import random

import pytest

from ingest.decoder import FrameSampler


def accepted(fps_in: float, target: float, seconds: float = 30, jitter: float = 0.0) -> float:
    s = FrameSampler(target)
    rng = random.Random(1)
    t, n = 0.0, 0
    while t < seconds:
        n += s.accept(t + rng.uniform(-jitter, jitter))
        t += 1 / fps_in
    return n / seconds


@pytest.mark.parametrize("fps_in, expected", [(15, 10), (25, 10), (30, 10), (10, 10), (8, 8), (5, 5)])
def test_rate_is_the_target_or_the_camera_rate(fps_in, expected):
    assert accepted(fps_in, 10) == pytest.approx(expected, rel=0.03)


def test_jittery_camera_at_the_target_rate():
    # A 10 fps camera whose frames arrive +-20 ms off schedule is still analysed at ~10 fps.
    assert accepted(10, 10, jitter=0.02) == pytest.approx(10, rel=0.05)


def test_no_burst_after_a_pause():
    s = FrameSampler(10)
    assert s.accept(0.0)
    # 5 s without video, then frames every 10 ms: only one catch-up slot, not 50.
    burst = sum(s.accept(5.0 + i * 0.01) for i in range(10))
    assert burst <= 2
